// GET /api/status[?id=<attempt>] — what is the current pairing doing?
//
// Without an attempt id this returns booleans only, exactly like the DP
// Fetcher: { ok, registered, hasSession } — credential values are NEVER
// returned or logged.
//
// With the attempt id returned by POST /api/pair it also returns the live
// attempt's state: { status: 'code'|'done'|'error', code?, sessionId?,
// error? }. The SESSION_ID appears only when THIS attempt completed, and
// only to a poller holding its (unguessable) id — a visitor cannot read
// anyone else's session id off this endpoint. The pairing code is shown
// only while the attempt is still waiting for the owner.

import { BufferJSON } from '@whiskeysockets/baileys';
import { kvConfigFromEnv, createKvClient, CREDS_KEY, RESULT_KEY } from '../lib/kv.js';
import { sendJson } from '../lib/util.js';

function queryId(req) {
  if (req.query && typeof req.query.id === 'string') return req.query.id;
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    return u.searchParams.get('id');
  } catch { return null; }
}

export function createStatusHandler(deps = {}) {
  return async (req, res) => {
    let registered = false;
    let hasSession = false;
    let result = null;
    try {
      const kv = deps.kv || createKvClient(kvConfigFromEnv());
      const raw = await kv.get(CREDS_KEY);
      if (raw) {
        hasSession = true;
        try { registered = !!JSON.parse(raw, BufferJSON.reviver).registered; } catch { registered = false; }
      }
      const resultRaw = await kv.get(RESULT_KEY);
      if (resultRaw) {
        try { result = JSON.parse(resultRaw); } catch { result = null; }
      }
    } catch { /* unconfigured KV reads as "not paired" */ }

    const out = { ok: true, registered, hasSession };
    if (result && result.status === 'done') {
      // The pairing completed: the session is registered even though the
      // KV creds were already wiped (keep-nothing model — see api/pair.js).
      registered = true;
      hasSession = true;
      out.registered = true;
      out.hasSession = true;
    }

    const id = queryId(req);
    if (id && result && result.id === id) {
      out.status = result.status;
      if (result.status === 'code' && result.code) out.code = result.code;
      if (result.status === 'code' && result.qr) out.qr = result.qr;
      if (result.status === 'done' && result.sessionId) out.sessionId = result.sessionId;
      if (result.status === 'error' && result.error) out.error = result.error;
    }
    sendJson(res, 200, out);
  };
}

export default createStatusHandler();
