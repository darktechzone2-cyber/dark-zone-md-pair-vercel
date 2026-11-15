// POST /api/pair { number } — request an 8-digit WhatsApp pairing code for
// the VISITOR's own number and return it immediately, together with an
// attempt id. The visitor enters the code in WhatsApp, the socket connects,
// and the SESSION_ID ("DZMD~...") lands in /api/status?id=<attempt id>
// (and is also sent to the visitor's own WhatsApp, like the Express original).
//
// Same proven shape as the DTZ DP Fetcher's api/pair.js — with three
// differences, all forced by this site's contract:
//
//  1. The DP Fetcher pairs ONE owner account and keeps the session forever.
//     This site pairs any visitor and keeps NOTHING: the moment the
//     SESSION_ID is issued (or the attempt fails) the KV session is wiped
//     (clearAuth) — the serverless equivalent of the Express original
//     deleting its temp auth dir after pairing.
//
//  2. The result is a per-attempt record (RESULT_KEY), not a permanent
//     session: /api/status returns the SESSION_ID only to a poller holding
//     the matching attempt id. A new pairing overwrites the record.
//
//  3. One pairing at a time. The KV session is a single login, so a second
//     number pairing at the same moment would corrupt the first. The lock
//     (LOCK_KEY) refuses it with 429; it self-heals after 60s.
//
// The code must reach the visitor within seconds, but the socket has to stay
// alive ~40s while they type it into WhatsApp. So this handler replies with
// {"ok":true,"code":"ABCD-1234","id":"..."} at once, and keeps the socket
// waiting in the background with waitUntil. The web UI polls /api/status
// for the result; a 60s maxDuration bounds the wait — no long stream is held,
// so switching to WhatsApp cannot kill the code.
//
// The code is requested ONLY after the socket proves it is connected:
// requestPairingCode() makes the 8-char code up locally and only registers
// it by sending companion_hello to the server. Before the handshake has
// produced a qr that send goes nowhere — the phone gets no "Enter code"
// notification and rejects the code as if it were random. If the handshake
// never completes, the handler fails honestly (502) instead of issuing a
// dead code. A code issued moments ago for the same number is handed back
// unchanged, because two live codes for one number conflict on WhatsApp's
// side.

import crypto from 'node:crypto';
import { BufferJSON } from '@whiskeysockets/baileys';
import { kvConfigFromEnv, createKvClient, CREDS_KEY, KEYS_KEY, PAIR_CODE_KEY, RESULT_KEY, LOCK_KEY } from '../lib/kv.js';
import { clearAuth } from '../lib/auth.js';
import { openSession, defaultLogger, defaultGetVersion } from '../lib/whatsapp.js';
import { encodeSessionId } from '../lib/session.js';
import { normalizeNumber, maskNumber, readJsonBody, clientIp, rateLimited, sendJson } from '../lib/util.js';
import { waitUntil as vercelWaitUntil } from '@vercel/functions';

const pairHits = new Map();

// Same message the Express original sends the visitor on their own WhatsApp
// after pairing (kept byte-identical so the experience does not change).
const HOW_TO_USE =
  '🤖 *Dark Zone MD — your SESSION_ID*\n\n' +
  'Paste it into the bot\'s config.js as SESSION_ID (or set it as the ' +
  'SESSION_ID environment variable on your bot hosting), then start the bot — ' +
  'it connects directly, no pairing needed.\n\n' +
  '⚠️ Keep it secret: anyone with this ID can log in as this WhatsApp number.\n\n' +
  'SESSION_ID:\n';

const CODE_REUSE_MS = 60_000; // a live code is handed back unchanged within this window
const LOCK_MS = 60_000;       // one pairing at a time; stale locks are ignored

export function createPairHandler(deps = {}) {
  const makeSocket = deps.makeSocket;
  const getVersion = deps.getVersion;
  const logger = deps.logger || defaultLogger();
  const connectTimeoutMs = deps.connectTimeoutMs ?? 10000; // handshake (qr) wait before asking for a code
  const waitMs = deps.waitMs ?? 40000;          // how long to wait for the owner to enter the code
  const waitUntilFn = deps.waitUntil || vercelWaitUntil;

  return async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed. Use POST.' });
      return;
    }
    if (rateLimited(pairHits, clientIp(req), 6, 10 * 60_000)) {
      sendJson(res, 429, { ok: false, error: 'Too many pairing attempts. Wait a few minutes.' });
      return;
    }
    const body = await readJsonBody(req);
    const digits = normalizeNumber(body && body.number);
    if (!digits) {
      sendJson(res, 400, { ok: false, error: 'Enter a valid WhatsApp number with country code (10–15 digits, e.g. 923001234567).' });
      return;
    }

    let kv;
    try {
      kv = deps.kv || createKvClient(kvConfigFromEnv());
    } catch {
      sendJson(res, 500, { ok: false, error: 'Server storage is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel.' });
      return;
    }

    // 1. A code issued moments ago for this number is still live: hand back
    // the SAME code (and the same attempt id, so the poller keeps working).
    // A second live code for one number conflicts with the first on
    // WhatsApp's side (the phone can only complete one of them).
    try {
      const markerRaw = await kv.get(PAIR_CODE_KEY);
      if (markerRaw) {
        const marker = JSON.parse(markerRaw);
        if (marker && marker.number === digits && marker.code && Date.now() - (marker.at || 0) < CODE_REUSE_MS) {
          sendJson(res, 200, { ok: true, code: marker.code, id: marker.id, reused: true });
          return;
        }
      }
    } catch { /* no usable marker: proceed */ }

    // 2. One pairing at a time: the KV session is a single WhatsApp login.
    // A different number with a live lock gets a clear 429 (not a corrupt
    // mix of two pairings). Stale locks (>60s) are ignored.
    try {
      const lockRaw = await kv.get(LOCK_KEY);
      if (lockRaw) {
        const lock = JSON.parse(lockRaw);
        if (lock && lock.number && lock.number !== digits && Date.now() - (lock.at || 0) < LOCK_MS) {
          sendJson(res, 429, { ok: false, error: 'Another pairing is in progress. Please wait a minute and try again.' });
          return;
        }
      }
    } catch { /* no usable lock: proceed */ }

    const attemptId = crypto.randomBytes(9).toString('hex');
    // The QR arrives with the handshake (same server answer as the code
    // gate). Capture it so the page can offer QR scanning as a fallback
    // when the pairing-code notification never arrives.
    let latestQr = null;
    const onQr = (qr) => { latestQr = qr; };

    // 3. Open a socket. A failed attempt leaves unregistered creds behind;
    // WhatsApp kills a re-used dead session with 401 loggedOut, and the
    // handler then saves those dead creds back — so every retry fails the
    // same way. Start from blank creds when a stale session is stored.
    let session;
    try {
      session = await openSession({ kv, makeSocket, getVersion, logger, onQr });
    } catch {
      sendJson(res, 502, { ok: false, error: 'Could not start a WhatsApp connection. Try again.' });
      return;
    }
    if (session.hadStored) {
      session.disconnect();
      await clearAuth(kv).catch(() => {});
      try {
        session = await openSession({ kv, makeSocket, getVersion, logger, onQr });
      } catch {
        sendJson(res, 502, { ok: false, error: 'Could not start a WhatsApp connection. Try again.' });
        return;
      }
    }

    // 4. Gate: only ask for the code once the server has answered the
    // handshake with pairing refs (a qr). Before this point
    // requestPairingCode() returns a code that was never registered, the
    // phone gets no notification, and the code is dead on arrival.
    try {
      await session.waitForConnectable(connectTimeoutMs);
    } catch {
      session.disconnect();
      sendJson(res, 502, { ok: false, error: 'Could not connect to WhatsApp. Try again in a moment.' });
      return;
    }

    let code;
    try {
      console.log('requesting code, wsOpen=', session.sock.ws?.isOpen ?? 'unknown');
      code = await session.sock.requestPairingCode(digits);
      console.log('requestPairingCode returned, wsOpen=', session.sock.ws?.isOpen ?? 'unknown');
    } catch {
      await session.persist().catch(() => {});
      session.disconnect();
      sendJson(res, 502, { ok: false, error: 'Could not request a pairing code for that number. Check the number and try again.' });
      return;
    }
    const now = Date.now();
    await kv.set(PAIR_CODE_KEY, JSON.stringify({ code, number: digits, id: attemptId, at: now })).catch(() => {});
    await kv.set(LOCK_KEY, JSON.stringify({ id: attemptId, number: digits, at: now })).catch(() => {});
    const resultRec = { id: attemptId, number: digits, status: 'code', code, at: now };
    if (latestQr) resultRec.qr = latestQr;
    await kv.set(RESULT_KEY, JSON.stringify(resultRec)).catch(() => {});
    console.log('pair code issued for', maskNumber(digits));

    // Reply NOW; keep the socket waiting in the background with waitUntil
    // (see the header comment for why the stream must not be held open).
    const settlePair = (async () => {
      let sessionId = null;
      try {
        const result = await session.waitForOpen(waitMs);
        console.log('pair settle result:', result);
        if (result === 'open' || result === 'restarted') {
          await session.persist().catch(() => {});
          // Encode exactly what the Express original encoded: the raw
          // creds JSON (BufferJSON-serialized, so the byte format matches
          // the creds.json the bot reads back).
          try {
            sessionId = encodeSessionId(JSON.stringify(session.creds, BufferJSON.replacer));
          } catch { sessionId = null; }
          if (!sessionId) throw new Error('encode-failed');
          // Send the id to the visitor's own WhatsApp, like the original.
          // On 'restarted' the socket is already closed — skip the send,
          // the page still shows the id.
          if (result === 'open') {
            try {
              await session.sock.sendMessage(digits + '@s.whatsapp.net', { text: HOW_TO_USE + sessionId });
            } catch { /* the page still shows the SESSION_ID */ }
          }
          await kv.set(RESULT_KEY, JSON.stringify({ id: attemptId, number: digits, status: 'done', sessionId, at: Date.now() })).catch(() => {});
          console.log('pair done for', maskNumber(digits));
        }
      } catch (e) {
        console.log('pair settle failed:', e.message);
        if (e.message === 'loggedOut' || e.message === 'encode-failed') {
          await kv.set(RESULT_KEY, JSON.stringify({ id: attemptId, number: digits, status: 'error', error: 'WhatsApp logged the session out. Request a new code.', at: Date.now() })).catch(() => {});
        } else {
          await kv.set(RESULT_KEY, JSON.stringify({ id: attemptId, number: digits, status: 'error', error: 'Pairing timed out. Please request a new code.', at: Date.now() })).catch(() => {});
        }
      } finally {
        // Keep nothing: wipe the session, the live-code marker and the lock.
        // The SESSION_ID lives only in the result record, which the next
        // pairing overwrites — and only a poller holding the attempt id
        // can read it back (see api/status.js).
        await clearAuth(kv).catch(() => {});
        await kv.del(PAIR_CODE_KEY).catch(() => {});
        await kv.del(LOCK_KEY).catch(() => {});
        session.disconnect();
      }
    })();
    try { waitUntilFn(settlePair); } catch { /* not on Vercel: promise still runs */ }

    const reply = { ok: true, code, id: attemptId };
    if (latestQr) reply.qr = latestQr;
    sendJson(res, 200, reply);
  };
}

export default createPairHandler();
