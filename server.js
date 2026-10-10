/**
 * server.js - WhatsApp <-> Vercel bridge
 *
 *   WhatsApp --(Baileys)--> this server --POST--> Vercel /api/webhook/baileys
 *   Vercel   --POST /send-message--> this server --(Baileys)--> WhatsApp
 *
 * Auth state is persisted in Supabase (authStore.js), so restarts and
 * redeploys reconnect without a new QR scan. Outbound messages follow a
 * humanized workflow (typing indicator + random delay) with rate limiting.
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import axios from 'axios';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { createClient } from '@supabase/supabase-js';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  isJidGroup,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
} from '@whiskeysockets/baileys';

import { createSupabaseAuthStore } from './authStore.js';

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'VERCEL_WEBHOOK_URL', 'BRIDGE_SECRET'];
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missingEnv.length) {
  console.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  console.error('Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

const intEnv = (name, fallback) => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const resolveSelfUrl = () => {
  if (process.env.KEEP_ALIVE_URL) return process.env.KEEP_ALIVE_URL;
  if (process.env.RENDER_EXTERNAL_URL) return `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')}/health`;
  if (process.env.PROJECT_DOMAIN) return `https://${process.env.PROJECT_DOMAIN}.glitch.me/health`;
  return null;
};

const config = {
  port: process.env.PORT || 3000, // Glitch/Render/Railway assign the port at runtime
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  webhookUrl: process.env.VERCEL_WEBHOOK_URL,
  bridgeSecret: process.env.BRIDGE_SECRET,
  sessionId: process.env.SESSION_ID || 'default',

  webhookTimeoutMs: intEnv('WEBHOOK_TIMEOUT_MS', 25_000),
  webhookMaxAttempts: 3,

  // Humanized sending (anti-ban)
  typingDelayMinMs: 3000,
  typingDelayMaxMs: 5000,

  // Outbound rate limiting
  maxPendingPerJid: intEnv('MAX_PENDING_PER_JID', 3), // queued + in-flight per recipient
  minGapPerJidMs: intEnv('MIN_GAP_PER_JID_MS', 2000), // pause between two sends to the same chat
  maxMessagesPerMinute: intEnv('MAX_MESSAGES_PER_MINUTE', 20), // global ceiling

  // Self-ping target. Priority: KEEP_ALIVE_URL, Render's RENDER_EXTERNAL_URL, Glitch's PROJECT_DOMAIN.
  keepAliveUrl: resolveSelfUrl(),
  keepAliveIntervalMs: 3 * 60 * 1000,
  maxReconnectDelayMs: 30_000,
};

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
// Baileys is very chatty at info level; keep it at warn unless overridden.
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' });

const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const authStore = createSupabaseAuthStore({
  client: supabase,
  sessionId: config.sessionId,
  logger: logger.child({ module: 'authStore' }),
});

/* -------------------------------------------------------------------------- */
/* Runtime state                                                              */
/* -------------------------------------------------------------------------- */

/** 'connecting' | 'open' | 'close' | 'logged_out' | 'replaced' */
let connectionState = 'close';
let sock = null;
let generation = 0; // identifies the current socket; events from older sockets are ignored
let starting = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let shuttingDown = false;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/** Constant-time comparison of the shared secret. */
function secretsMatch(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireBridgeSecret(req, res, next) {
  const provided = req.get('x-bridge-secret');
  if (!provided || !secretsMatch(provided, config.bridgeSecret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

/**
 * Build the target JID.
 *   isGroup true  -> "<id>@g.us"            (id = digits and hyphens)
 *   isGroup false -> "<digits>@s.whatsapp.net"
 * A full JID in `to` is accepted as long as it agrees with `isGroup`.
 * Returns `{ jid }` or `{ error }`.
 */
function buildJid(to, isGroup) {
  if (to === undefined || to === null || String(to).trim() === '') {
    return { error: '"to" is required' };
  }
  const raw = String(to).trim();
  const wantsGroup = isGroup === true || isGroup === 'true';

  if (raw.includes('@')) {
    const match = raw.match(/^([\w.:-]+)@(s\.whatsapp\.net|g\.us|lid)$/);
    if (!match) return { error: '"to" is not a valid WhatsApp JID' };
    const isGroupJid = match[2] === 'g.us';
    if (isGroup !== undefined && wantsGroup !== isGroupJid) {
      return { error: '"isGroup" does not match the JID suffix in "to"' };
    }
    return { jid: raw };
  }

  if (wantsGroup) {
    if (!/^[0-9]+(-[0-9]+)?$/.test(raw)) return { error: 'Group "to" must be a group id (digits, optional hyphen)' };
    return { jid: `${raw}@g.us` };
  }

  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) {
    return { error: '"to" must be a phone number with country code (digits only, e.g. "923096329525")' };
  }
  return { jid: `${digits}@s.whatsapp.net` };
}

/* -------------------------------------------------------------------------- */
/* Inbound: WhatsApp -> Vercel                                                */
/* -------------------------------------------------------------------------- */

/** Bounded set used to avoid forwarding the same WhatsApp message twice. */
const seenMessageIds = new Set();
function alreadySeen(id) {
  if (!id) return false;
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.add(id);
  if (seenMessageIds.size > 2000) seenMessageIds.delete(seenMessageIds.values().next().value);
  return false;
}

/** Plain text of a message, looking through ephemeral/view-once wrappers and captions. */
function extractText(content) {
  if (!content) return '';
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    ''
  ).trim();
}

const toNumber = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber();
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Raw Baileys message -> clean payload for Vercel.
 * Returns null for messages that should not be forwarded.
 */
function adaptMessage(msg) {
  const key = msg.key;
  if (!key?.id || !key.remoteJid) return null;
  if (key.fromMe) return null; // the bot's own messages
  if (key.remoteJid === 'status@broadcast' || key.remoteJid.endsWith('@broadcast')) return null; // status & broadcast lists
  if (key.remoteJid.endsWith('@newsletter')) return null;

  const content = normalizeMessageContent(msg.message);
  const text = extractText(content);
  if (!text) return null; // no text (e.g. stickers, voice notes, protocol stubs)

  const chatJid = key.remoteJid;
  const isGroup = Boolean(isJidGroup(chatJid));
  const sender = isGroup ? key.participant || msg.participant || null : chatJid;

  return {
    sender,
    text,
    pushName: msg.pushName || null,
    messageId: key.id,
    chatJid,
    isGroup,
    timestamp: toNumber(msg.messageTimestamp) ?? Math.floor(Date.now() / 1000),
    messageType: getContentType(content) || null,
  };
}

async function forwardToVercel(payload) {
  const { messageId } = payload;

  for (let attempt = 1; attempt <= config.webhookMaxAttempts; attempt += 1) {
    try {
      const res = await axios.post(config.webhookUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          'x-bridge-secret': config.bridgeSecret,
        },
        timeout: config.webhookTimeoutMs,
      });
      logger.info({ messageId, chatJid: payload.chatJid, status: res.status }, 'Forwarded message to Vercel');
      return true;
    } catch (err) {
      const status = err.response?.status;
      // Retry only when Vercel certainly did not process the request: connection-level
      // failures (no response, not a timeout) and 429/502/503. Timeouts and 504 are NOT
      // retried, since the function may still be running and a retry could double-reply.
      const timedOut = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
      const retriable = (!err.response && !timedOut) || [429, 502, 503].includes(status);

      logger.warn(
        { messageId, attempt, status, code: err.code, retriable, err: err.message },
        'Failed to forward message to Vercel',
      );

      if (!retriable || attempt === config.webhookMaxAttempts) return false;
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
  return false;
}

function handleMessagesUpsert(socketGeneration, { messages, type }) {
  if (socketGeneration !== generation) return;
  if (type !== 'notify') return; // ignore history sync / appended messages

  for (const msg of messages) {
    const payload = adaptMessage(msg);
    if (!payload) continue;
    if (alreadySeen(payload.messageId)) continue;

    forwardToVercel(payload)
      .then((ok) => {
        if (!ok) seenMessageIds.delete(payload.messageId); // allow a redelivery to try again
      })
      .catch((err) => logger.error({ messageId: payload.messageId, err: err.message }, 'Unexpected webhook error'));
  }
}

/* -------------------------------------------------------------------------- */
/* Outbound: Vercel -> WhatsApp (humanized + rate limited)                    */
/* -------------------------------------------------------------------------- */

class RateLimitError extends Error {
  constructor(message, retryAfterSec) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterSec = retryAfterSec;
  }
}

/** jid -> { tail: Promise, pending: number, lastSentAt: number } */
const sendLanes = new Map();
/** Timestamps (ms) of accepted sends, for the global per-minute ceiling. */
let recentSends = [];

/**
 * Queue `task` behind earlier sends to the same chat (strictly one at a time, with a
 * minimum gap), or reject with RateLimitError when limits are exceeded.
 */
function enqueueSend(jid, task) {
  const now = Date.now();

  recentSends = recentSends.filter((t) => now - t < 60_000);
  if (recentSends.length >= config.maxMessagesPerMinute) {
    const retryAfter = Math.max(1, Math.ceil((recentSends[0] + 60_000 - now) / 1000));
    throw new RateLimitError('Global outbound rate limit reached', retryAfter);
  }

  let lane = sendLanes.get(jid);
  if (!lane) {
    lane = { tail: Promise.resolve(), pending: 0, lastSentAt: 0 };
    sendLanes.set(jid, lane);
  }
  if (lane.pending >= config.maxPendingPerJid) {
    const retryAfter = Math.ceil(((config.typingDelayMaxMs + config.minGapPerJidMs) * lane.pending) / 1000);
    throw new RateLimitError('Too many pending messages for this recipient', retryAfter);
  }

  recentSends.push(now);
  lane.pending += 1;

  const run = lane.tail.then(async () => {
    const wait = lane.lastSentAt + config.minGapPerJidMs - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await task();
    } finally {
      lane.lastSentAt = Date.now();
    }
  });

  lane.tail = run.catch(() => {});
  const release = () => {
    lane.pending -= 1;
  };
  run.then(release, release);

  return run;
}

// Drop idle lanes so the map cannot grow forever.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [jid, lane] of sendLanes) {
    if (lane.pending === 0 && lane.lastSentAt < cutoff) sendLanes.delete(jid);
  }
}, 5 * 60 * 1000).unref();

/**
 * Humanized dispatch:
 *   1. presence "composing"
 *   2. random 3000-5000 ms delay
 *   3. presence "paused"
 *   4. send the message
 */
async function sendHumanized(jid, text) {
  const socket = sock;
  if (!socket || connectionState !== 'open') {
    const err = new Error('WhatsApp is not connected');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  let composing = false;
  try {
    await socket.sendPresenceUpdate('composing', jid);
    composing = true;

    await new Promise((resolve) =>
      setTimeout(resolve, randomInt(config.typingDelayMinMs, config.typingDelayMaxMs)),
    );

    await socket.sendPresenceUpdate('paused', jid);
    composing = false;

    if (connectionState !== 'open') {
      const err = new Error('WhatsApp disconnected while preparing the message');
      err.code = 'NOT_CONNECTED';
      throw err;
    }

    return await socket.sendMessage(jid, { text });
  } catch (err) {
    if (composing) {
      // Don't leave a "typing..." indicator dangling after a failure.
      await socket.sendPresenceUpdate('paused', jid).catch(() => {});
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* WhatsApp socket lifecycle                                                  */
/* -------------------------------------------------------------------------- */

async function resolveWaVersion() {
  try {
    const { version, error } = await fetchLatestBaileysVersion();
    if (error) throw error;
    return version;
  } catch (err) {
    logger.warn({ err: err?.message }, 'Could not fetch latest WhatsApp Web version; using Baileys default');
    return undefined;
  }
}

function scheduleReconnect(forcedDelayMs) {
  if (shuttingDown || reconnectTimer) return;

  const delay = forcedDelayMs ?? Math.min(1000 * 2 ** reconnectAttempts, config.maxReconnectDelayMs);
  reconnectAttempts += 1;

  logger.warn({ delayMs: delay, attempt: reconnectAttempts }, 'Scheduling WhatsApp reconnect');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startSocket();
  }, delay);
}

/** Explicit logout: flush stored auth and start over, which prints a fresh QR. */
async function handleLoggedOut() {
  logger.error('Logged out from WhatsApp. Flushing stored session; a fresh QR code will be printed.');
  connectionState = 'logged_out';

  try {
    await authStore.clear();
  } catch (err) {
    // Must not reconnect with stale credentials, or we would loop on 401s.
    logger.error({ err: err.message }, 'Failed to flush Supabase auth state; retrying in 5s');
    if (!shuttingDown) setTimeout(handleLoggedOut, 5000);
    return;
  }

  reconnectAttempts = 0;
  scheduleReconnect(1000);
}

function handleConnectionUpdate(socketGeneration, update) {
  if (socketGeneration !== generation) return;
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    logger.info('Scan this QR code with WhatsApp > Settings > Linked devices > Link a device');
    qrcode.generate(qr, { small: true });
  }

  if (connection === 'connecting') {
    connectionState = 'connecting';
  }

  if (connection === 'open') {
    connectionState = 'open';
    reconnectAttempts = 0;
    logger.info({ me: sock?.user?.id }, 'WhatsApp connection open');
  }

  if (connection === 'close') {
    connectionState = 'close';
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const reason = lastDisconnect?.error?.message;
    logger.warn({ statusCode, reason }, 'WhatsApp connection closed');

    if (shuttingDown) return;

    if (statusCode === DisconnectReason.loggedOut) {
      handleLoggedOut();
    } else if (statusCode === DisconnectReason.connectionReplaced) {
      // Another process opened a session with the same credentials. Reconnecting would make
      // two instances kick each other off forever, so stay down and say why.
      connectionState = 'replaced';
      logger.error(
        'Connection replaced: another instance is using this WhatsApp session. Not reconnecting. ' +
          'Make sure only ONE instance (local or cloud) runs at a time, then restart this one.',
      );
    } else if (statusCode === DisconnectReason.restartRequired) {
      scheduleReconnect(0); // expected right after pairing
    } else {
      scheduleReconnect();
    }
  }
}

async function startSocket() {
  if (shuttingDown || starting) return;
  starting = true;
  const socketGeneration = ++generation;

  try {
    connectionState = 'connecting';

    try {
      sock?.end(undefined); // drop any lingering previous socket
    } catch {
      /* already closed */
    }

    const { state, saveCreds } = await authStore.loadState();
    const version = await resolveWaVersion();

    const socket = makeWASocket({
      version,
      logger: baileysLogger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false, // stay "offline" so phone notifications keep working
      generateHighQualityLinkPreview: false,
    });
    sock = socket;

    // Real-time persistence of credential changes.
    socket.ev.on('creds.update', () => {
      saveCreds().catch((err) => logger.error({ err: err.message }, 'Failed to persist creds to Supabase'));
    });
    socket.ev.on('connection.update', (update) => handleConnectionUpdate(socketGeneration, update));
    socket.ev.on('messages.upsert', (event) => handleMessagesUpsert(socketGeneration, event));
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to start WhatsApp socket');
    connectionState = 'close';
    scheduleReconnect();
  } finally {
    starting = false;
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP API                                                                   */
/* -------------------------------------------------------------------------- */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Liveness endpoints. `/` satisfies Glitch/Render edge proxies, `/health` is for uptime monitors.
// Always HTTP 200 so pingers keep the instance awake even while WhatsApp is reconnecting.
const statusHandler = (req, res) => {
  res.status(200).json({
    status: 'ok',
    connectionState,
    uptime: Math.floor(process.uptime()),
  });
};
app.get('/', statusHandler);
app.get('/health', statusHandler);

// Vercel -> WhatsApp
app.post('/send-message', requireBridgeSecret, async (req, res) => {
  const { to, text, isGroup } = req.body ?? {};

  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: '"text" must be a non-empty string' });
  }
  if (text.length > 4096) {
    return res.status(400).json({ error: '"text" must be at most 4096 characters' });
  }

  const { jid, error } = buildJid(to, isGroup);
  if (error) return res.status(400).json({ error });

  if (!sock || connectionState !== 'open') {
    return res.status(503).json({ error: 'WhatsApp is not connected', connectionState });
  }

  try {
    const sent = await enqueueSend(jid, () => sendHumanized(jid, text));
    logger.info({ to: jid, id: sent?.key?.id }, 'Sent WhatsApp message');
    return res.json({ success: true, messageId: sent?.key?.id ?? null, to: jid });
  } catch (err) {
    if (err instanceof RateLimitError) {
      logger.warn({ to: jid, reason: err.message }, 'Outbound message rejected by rate limiter');
      res.set('Retry-After', String(err.retryAfterSec));
      return res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSec });
    }
    if (err.code === 'NOT_CONNECTED') {
      return res.status(503).json({ error: err.message, connectionState });
    }
    logger.error({ to: jid, err: err.message }, 'Failed to send WhatsApp message');
    return res.status(502).json({ error: 'Failed to send message', details: err.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  logger.error({ err: err.message }, 'Unhandled HTTP error');
  return res.status(500).json({ error: 'Internal server error' });
});

/* -------------------------------------------------------------------------- */
/* Boot & shutdown                                                            */
/* -------------------------------------------------------------------------- */

const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info({ port: config.port }, 'Bridge server listening');
  startSocket();
});

// Self-ping every 3 minutes (when a public URL is known) so free containers don't idle out.
if (config.keepAliveUrl) {
  logger.info({ url: config.keepAliveUrl }, 'Self keep-alive ping enabled');
  setInterval(() => {
    axios.get(config.keepAliveUrl, { timeout: 10_000 }).catch((err) => {
      logger.debug({ err: err.message }, 'Keep-alive ping failed');
    });
  }, config.keepAliveIntervalMs).unref();
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  if (reconnectTimer) clearTimeout(reconnectTimer);
  setTimeout(() => process.exit(0), 8000).unref(); // hard stop

  try {
    sock?.end(undefined); // end() (not logout()) keeps the linked device registered
  } catch {
    /* ignore */
  }

  try {
    await authStore.flush(); // let pending auth writes reach Supabase
  } catch {
    /* ignore */
  }

  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason: reason instanceof Error ? reason.message : reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  // State is safely persisted in Supabase, so a clean exit + platform restart is the safest recovery.
  logger.fatal({ err: err.message, stack: err.stack }, 'Uncaught exception - exiting');
  process.exit(1);
});
