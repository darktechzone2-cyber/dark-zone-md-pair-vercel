# Dark Zone MD Pair — Vercel serverless version v1.0

The public pairing website for **Dark Zone MD**, rebuilt as Vercel serverless
functions because the Wispbyte deploy is blocked by an impassable Cloudflare
Turnstile check. Same flow as the Express original
(`~/workspace/dark-zone-md-pair/`): a visitor enters their WhatsApp number,
gets an 8-digit pairing code, links the device in WhatsApp, and receives a
**SESSION_ID** (`DZMD~...`) — shown on the page AND sent to their own
WhatsApp. Paste it into the bot's `config.js` as `SESSION_ID` (or set it as
the `SESSION_ID` env var) and the bot connects directly, no pairing needed.

## How it works (serverless)

There is no always-on server, so the Baileys session lives in **Upstash KV**
for the ~60 seconds a pairing is in flight:

- `POST /api/pair` opens a socket from the KV session, waits for the server
  handshake to produce a `qr` (the only proof a pairing code can actually
  register — see below), requests the code, and replies with
  `{ ok, code, id }` immediately. The socket keeps waiting in the background
  with `waitUntil` while the visitor types the code into WhatsApp.
- `GET /api/status?id=<attempt>` is polled by the page. When pairing
  completes it returns the `SESSION_ID` — only to a poller holding the
  matching attempt id. Without an id it returns booleans only
  (`{ ok, registered, hasSession }`), never credential values.
- The moment pairing finishes (or fails), the KV session is **wiped** —
  the serverless equivalent of the original deleting its temp auth dir.
  The site keeps nothing.

The pairing code is requested ONLY after the socket proves it is connected:
`requestPairingCode()` makes the 8-char code up locally and only registers
it by sending `companion_hello` to the server. Before the handshake has
produced a `qr` that send goes nowhere — the phone gets no "Enter code"
notification and rejects the code as if it were random. If the handshake
never completes, the handler fails honestly with 502 instead of issuing a
dead code. (This is the fix the DP Fetcher needed after six dead codes in a
row.) A code issued moments ago for the same number is handed back
unchanged — two live codes for one number conflict on WhatsApp's side.

## Routes

| Route | What it does |
|---|---|
| `GET /` | the web UI (same look as the original pair site) |
| `POST /api/pair` | `{ number }` → `{ ok, code, id }` (8-digit pairing code + attempt id) |
| `GET /api/status?id=<attempt>` | `{ ok, registered, hasSession, status, code?, sessionId?, error? }` |

## Deploy (Vercel)

1. Create a **free Upstash Redis** database (Upstash console or Vercel
   Marketplace → Upstash Redis) and copy its **REST URL** and **REST token**.
   (The existing `dtz-admin-panel` / `dtz-dp-fetcher` KV store can be reused —
   this project only touches `dtz:md-pair:*` keys.)
2. Import this folder/repo into Vercel (or `vercel` from the folder).
3. In the Vercel project → Settings → Environment Variables, add:
   - `UPSTASH_REDIS_REST_URL` = the REST URL
   - `UPSTASH_REDIS_REST_TOKEN` = the REST token

   (Alternatively `KV_REST_API_URL` / `KV_REST_API_TOKEN` — same values.)
4. Deploy. Open the site, enter a number, get the code, enter it in
   WhatsApp → the SESSION_ID appears on the page and in your own WhatsApp.

No GitHub repo is required for the deploy — Vercel can import a local folder
through `vercel`, or a fresh repo can be created from this folder.

## Usage

1. Open the site, enter your WhatsApp number with country code
   (e.g. `923001234567`) → **Get Pairing Code**.
2. In WhatsApp: **Settings → Linked Devices → Link a Device → Link with
   phone number instead** → enter the code. Be ready in WhatsApp **before**
   you request the code — you have about **40 seconds**.
3. The SESSION_ID appears on the page (copy it) and is also sent to your own
   WhatsApp chat. Paste it into the bot's `config.js` as `SESSION_ID`.

## Honest limits (read this)

- **Pairing window is ~40 seconds.** The code only works while the
  serverless function is alive (Vercel kills it at 60s). Enter the code in
  WhatsApp immediately. If it expires, request a new one.
- **One pairing at a time.** The KV session is a single WhatsApp login, so
  a second number pairing in the same minute gets a clear "another pairing
  is in progress" message instead of corrupting the first. (The Express
  original ran one temp auth dir per visitor; serverless cannot.)
- **Numbers are logged masked only** (`923***67`); codes and session ids are
  never logged. The SESSION_ID is readable via `/api/status` only with the
  attempt id, and the next pairing overwrites the stored record.
- **Rate limits:** 6 pairing attempts per 10 minutes per IP.
- **If WhatsApp logs the session out mid-pairing**, request a new code —
  the dead session is wiped automatically so the retry starts fresh.

## Files

```text
api/pair.js       # pairing: qr gate, code, background wait, SESSION_ID issue + wipe
api/status.js     # pairing state (+ SESSION_ID, only with the attempt id)
lib/kv.js         # Upstash REST client (dtz:md-pair:* keys)
lib/auth.js       # KV-backed Baileys auth state
lib/whatsapp.js   # socket open/wait helpers (waitForConnectable = qr gate)
lib/session.js    # DZMD~ SESSION_ID encode/decode (identical to the original)
lib/util.js       # number + rate-limit + JSON helpers
public/index.html # the web UI (original pair site look)
public/logo.png   # Dark Tech Zone logo
tests/            # run: npm test (no real WhatsApp / no real Upstash — all faked)
```

## Tests

```bash
npm install
npm test
```

## Common problems

- **"Server storage is not configured"** — the Upstash env vars are missing
  in Vercel. Add them and redeploy.
- **"Could not connect to WhatsApp"** — the Baileys handshake never
  produced a `qr` (WhatsApp unreachable from the function). Wait a moment
  and request a new code; do NOT reuse a code from a failed attempt.
- **"Pairing timed out"** — you took longer than ~40 seconds. Have WhatsApp
  open on Linked devices before requesting the code.
- **"Another pairing is in progress"** — someone else is pairing right now.
  Wait a minute and try again.

Dark Tech Zone — Learn. Build. Secure.
