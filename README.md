# WhatsApp ⇄ Vercel Bridge

Always-on Node.js service (Render/Railway) that connects a WhatsApp number via
[`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) to a Next.js backend on Vercel.

```
WhatsApp ──► Bridge ──POST──► https://cr-agent.vercel.app/api/webhook/baileys
WhatsApp ◄── Bridge ◄─POST─── Vercel  (POST /send-message)
```

Requires **Node.js 20+**.

## Setup

1. **Supabase:** run `supabase_schema.sql` in the SQL Editor. Copy the Project URL and the `service_role` key.
2. **Local first run (recommended, so the QR is easy to scan):**
   ```bash
   npm install
   cp .env.example .env     # fill in values; BRIDGE_SECRET: openssl rand -hex 32
   npm start
   ```
   Scan the QR printed in the terminal (WhatsApp → Linked devices → Link a device). Then stop it with Ctrl+C.
   **Only one instance may run per session**; a second one triggers `connection replaced` and the bridge stays down on purpose.
3. **Render:** New Web Service → build `npm install`, start `npm start`, health check path `/health`,
   set the env vars from `.env.example` (plus `NODE_VERSION=20`). **Railway:** deploy from GitHub, add the same variables, generate a domain.
4. **Free tier:** the bridge pings its own public URL every 3 minutes (auto-detected from `RENDER_EXTERNAL_URL` or Glitch's
   `PROJECT_DOMAIN`; set `KEEP_ALIVE_URL` on other hosts). Also add an external monitor (UptimeRobot, cron-job.org) on `/health`,
   since a sleeping container cannot wake itself.
5. **Glitch:** the code reads `PORT` and `PROJECT_DOMAIN` as Glitch provides them and `.env` works as usual, but note that
   **Glitch ended project hosting on July 8, 2025**, so use Render or Railway instead. Baileys also needs Node 20+.

## API

**`GET /`** and **`GET /health`** → HTTP 200 `{ "status": "ok", "connectionState": "open", "uptime": 1234 }`

**`POST /send-message`** (header `x-bridge-secret`, else `401`)
```json
{ "to": "1203630123456789@g.us", "text": "Message...", "isGroup": true }
{ "to": "923096329525", "text": "Hello" }
```
Individuals use digits with country code (no `+`/leading 0) → `@s.whatsapp.net`; groups → `@g.us`.
Each message is sent as: `composing` presence → random 3–5 s delay → `paused` → message.
The call returns after delivery: `{ "success": true, "messageId": "...", "to": "..." }`.
Errors: `400` invalid input, `401` bad secret, `429` rate limited (with `Retry-After`), `503` not connected, `502` send failed.

**Rate limiting:** messages to the same chat are sent strictly one at a time with a minimum gap; more than
`MAX_PENDING_PER_JID` (default 3) waiting → `429`. A global cap of `MAX_MESSAGES_PER_MINUTE` (default 20) also applies.

**Inbound webhook** → `POST VERCEL_WEBHOOK_URL` with header `x-bridge-secret`:
```json
{
  "sender": "923096329525@s.whatsapp.net",
  "text": "Hello!",
  "pushName": "Ali",
  "messageId": "3EB0...",
  "chatJid": "923096329525@s.whatsapp.net",
  "isGroup": false,
  "timestamp": 1760000000,
  "messageType": "conversation"
}
```
In groups `chatJid` is the `...@g.us` id and `sender` is the participant. Skipped: own messages, status/broadcast,
and messages without text (stickers, voice notes...). Return `200` quickly; use `messageId` as an idempotency key.
Retries happen only on connection errors / 429 / 502 / 503, never on timeouts.

## Self-healing

| Situation | Behaviour |
|---|---|
| Restart / redeploy | Session loaded from Supabase, no QR. |
| Disconnect | Reconnects with backoff (1 s → 30 s). |
| Logged out from phone | `baileys_auth` rows for the session are flushed, a fresh QR is printed in the logs. |
| Session used elsewhere | Stays down (`connectionState: "replaced"`) to avoid a kick-loop. |

Baileys is an unofficial library and can violate WhatsApp's Terms of Service; use a number you can afford to lose.
