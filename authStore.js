/**
 * authStore.js
 *
 * Supabase-backed replacement for Baileys' `useMultiFileAuthState`.
 *
 * Every piece of auth data (the `creds` object and all Signal keys: pre-keys,
 * sessions, sender-keys, app-state-sync-keys, ...) is one row in `baileys_auth`:
 *
 *   id                      value (text)
 *   ----------------------  ------------------------------------------
 *   default:creds           BufferJSON string
 *   default:pre-key:12      BufferJSON string
 *   default:session:123.0   BufferJSON string
 *
 * CRYPTOGRAPHIC INTEGRITY
 *  All values are written with `JSON.stringify(value, BufferJSON.replacer)` and
 *  read with `JSON.parse(text, BufferJSON.reviver)`. Plain JSON.stringify would
 *  turn Buffers into number arrays / objects that no longer deserialize into
 *  Buffers, which corrupts the Signal sessions ("Bad MAC" errors and reconnect
 *  loops after a restart).
 *
 * OPERATIONAL DESIGN
 *  - All writes go through one serialized queue so ordering is preserved and a
 *    reconnect right after pairing always reads the creds that were just saved.
 *  - Reads/writes are retried with exponential backoff.
 *  - clear() bumps an "epoch" so late writes from a dead socket can never
 *    resurrect a session that was just wiped after a logout.
 */

import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

const TABLE = 'baileys_auth';
const READ_CHUNK_SIZE = 100;
const WRITE_CHUNK_SIZE = 200;
const DEFAULT_MAX_RETRIES = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** value (may contain Buffers) -> text. */
const serialize = (value) => JSON.stringify(value, BufferJSON.replacer);

/** text -> value (Buffers restored). */
const deserialize = (text) => JSON.parse(text, BufferJSON.reviver);

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const describeError = (err) => {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  return err.message || err.details || JSON.stringify(err);
};

/**
 * @param {object} options
 * @param {import('@supabase/supabase-js').SupabaseClient} options.client  Supabase client (service-role key).
 * @param {string} [options.sessionId='default']  Letters, digits and hyphens only.
 * @param {import('pino').Logger} [options.logger]
 * @param {number} [options.maxRetries=4]
 */
export function createSupabaseAuthStore({
  client,
  sessionId = 'default',
  logger,
  maxRetries = DEFAULT_MAX_RETRIES,
}) {
  if (!client) throw new Error('createSupabaseAuthStore: a Supabase client is required');
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) {
    throw new Error('sessionId may only contain letters, digits and hyphens');
  }

  const log = logger ?? { debug() {}, info() {}, warn() {}, error() {} };
  const prefix = `${sessionId}:`;
  const rowId = (name) => `${prefix}${name}`;

  let epoch = 0; // bumped by clear(); stale writes are dropped
  let queue = Promise.resolve(); // serialized write queue (never rejects)

  /** Run a Supabase call with retries. `fn` resolves to `{ data, error }`. */
  async function withRetry(label, fn) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        const { data, error } = await fn();
        if (error) throw error;
        return data;
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          log.warn({ label, attempt, err: describeError(err) }, 'Supabase call failed, retrying');
          await sleep(250 * 2 ** (attempt - 1));
        }
      }
    }
    throw new Error(`Supabase "${label}" failed after ${maxRetries} attempts: ${describeError(lastError)}`);
  }

  function enqueue(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  }

  const flush = () => queue;

  async function upsertRows(rows) {
    for (const part of chunk(rows, WRITE_CHUNK_SIZE)) {
      await withRetry('upsert', () => client.from(TABLE).upsert(part, { onConflict: 'id' }));
    }
  }

  async function deleteIds(ids) {
    for (const part of chunk(ids, WRITE_CHUNK_SIZE)) {
      await withRetry('delete', () => client.from(TABLE).delete().in('id', part));
    }
  }

  /** @returns {Promise<Map<string, string>>} row id -> stored text */
  async function readIds(ids) {
    await flush(); // read-your-writes
    const found = new Map();
    for (const part of chunk(ids, READ_CHUNK_SIZE)) {
      const rows = await withRetry('select', () =>
        client.from(TABLE).select('id, value').in('id', part),
      );
      for (const row of rows ?? []) found.set(row.id, row.value);
    }
    return found;
  }

  /** Same contract as `useMultiFileAuthState`: resolves `{ state, saveCreds }`. */
  async function loadState() {
    await flush();
    const stateEpoch = epoch;

    const row = await withRetry('load creds', () =>
      client.from(TABLE).select('value').eq('id', rowId('creds')).maybeSingle(),
    );

    const creds = row ? deserialize(row.value) : initAuthCreds();
    log.info(
      { sessionId },
      row
        ? 'Loaded existing WhatsApp session from Supabase'
        : 'No stored session found - a new QR code will be required',
    );

    const state = {
      creds,
      keys: {
        get: async (type, ids) => {
          const names = ids.map((id) => rowId(`${type}:${id}`));
          const found = await readIds(names);
          const data = {};
          ids.forEach((id, index) => {
            const text = found.get(names[index]);
            if (text === undefined || text === null) return;
            let value = deserialize(text);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          });
          return data;
        },

        // Real-time persistence of every key mutation.
        set: async (data) => {
          const upserts = [];
          const deletes = [];
          const now = new Date().toISOString();

          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const name = rowId(`${category}:${id}`);
              if (value === null || value === undefined) {
                deletes.push(name);
              } else {
                upserts.push({ id: name, value: serialize(value), updated_at: now });
              }
            }
          }

          if (!upserts.length && !deletes.length) return;

          await enqueue(async () => {
            if (stateEpoch !== epoch) return; // session was cleared meanwhile
            if (upserts.length) await upsertRows(upserts);
            if (deletes.length) await deleteIds(deletes);
          });
        },
      },
    };

    // Call from the `creds.update` event.
    const saveCreds = () => {
      const snapshot = serialize(creds); // snapshot now, write later (ordered)
      return enqueue(async () => {
        if (stateEpoch !== epoch) return;
        await upsertRows([
          { id: rowId('creds'), value: snapshot, updated_at: new Date().toISOString() },
        ]);
      });
    };

    return { state, saveCreds };
  }

  /** Delete every row of this session (creds + keys). Used after an explicit logout. */
  function clear() {
    epoch += 1; // invalidate pending/late writes from the old socket
    return enqueue(async () => {
      await withRetry('clear session', () => client.from(TABLE).delete().like('id', `${prefix}%`));
      log.warn({ sessionId }, 'Flushed WhatsApp auth state from Supabase');
    });
  }

  return { loadState, clear, flush };
}
