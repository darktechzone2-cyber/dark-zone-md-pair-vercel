// Baileys socket sessions for serverless: open a fresh connection per
// invocation, wait for it, do the one job, disconnect. Nothing is kept in
// memory between invocations — the session lives in KV (see lib/auth.js).
//
// Same implementation as dtz-dp-fetcher-vercel/lib/whatsapp.js, except the
// browser identity string matches the original pair site
// (['Ubuntu', 'Edge', '20.04'] — the identity the old working pair.js used).

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { loadAuth } from './auth.js';

const silentLogger = pino({ level: 'silent' });

// Diagnostic round: Baileys internals log at debug level (stanza traffic,
// including any error reply to the pairing registration). This flows to
// Vercel runtime logs. Revert to silent once pairing is proven live.
export function defaultLogger() { return pino({ level: 'debug' }); }

export async function defaultGetVersion() {
  try {
    return await fetchLatestBaileysVersion();
  } catch {
    return { version: [2, 3000, 0] };
  }
}

/**
 * Create one Baileys socket from the KV session. Returns a session object:
 *   { sock, creds, persist, waitForOpen(timeoutMs), disconnect }
 * waitForOpen resolves 'open', or 'restarted' when WhatsApp closes the
 * socket with restartRequired AFTER registering the creds (a normal
 * post-pairing close). It throws 'timeout' | 'loggedOut' | 'closed'.
 * waitForConnectable resolves once the server has answered the handshake
 * with pairing refs (a connection.update carrying a qr). It throws
 * 'connect-timeout' | 'loggedOut' | 'closed'.
 */
export async function openSession(deps = {}) {
  const kv = deps.kv;
  const makeSocket = deps.makeSocket || makeWASocket;
  const getVersion = deps.getVersion || defaultGetVersion;
  const logger = deps.logger || silentLogger;

  const { creds, keys, persist, hadStored } = await loadAuth(kv, logger);
  const { version } = await getVersion();
  const sock = makeSocket({
    version,
    logger,
    auth: { creds, keys },
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Edge', '20.04'], // same identity as the old working pair.js
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  // Persist on every credential change, so a killed invocation still
  // leaves a usable session in KV.
  sock.ev.on('creds.update', () => { persist().catch(() => {}); });

  // Diagnostics (console.log -> Vercel runtime logs): log every socket
  // event so a dead code can be told apart from a server that ignores the
  // registration stanza. Passive listeners only; they never resolve/reject.
  const logEv = (msg) => { try { console.log('[wa]', msg); } catch { /* ignore */ } };
  sock.ev.on('connection.update', (u) => {
    try {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      logEv(`update connection=${u.connection ?? '-'} qr=${u.qr ? 'yes' : 'no'} isNewLogin=${u.isNewLogin ?? '-'} disconnectCode=${code ?? '-'}`);
    } catch { /* ignore */ }
    if (u.qr) { try { deps.onQr?.(u.qr); } catch { /* ignore */ } }
  });
  sock.ev.on('creds.update', () => {
    try { logEv(`creds registered=${creds.registered === true}`); } catch { /* ignore */ }
  });
  try { sock.ws?.on?.('close', (c, r) => logEv(`ws close code=${c} reason=${r ? String(r) : '-'}`)); } catch { /* ignore */ }
  try { sock.ws?.on?.('error', (e) => logEv(`ws error ${e?.message ?? e}`)); } catch { /* ignore */ }

  function disconnect() {
    try { sock.end?.(); } catch { /* ignore */ }
    try { sock.ws?.close?.(); } catch { /* ignore */ }
  }

  function waitForOpen(timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error('timeout'));
      }, timeoutMs);
      const onUpdate = (u) => {
        if (done) return;
        if (u.connection === 'open') {
          done = true;
          cleanup();
          resolve('open');
          return;
        }
        if (u.connection === 'close') {
          const code = u.lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.restartRequired && creds.registered) {
            done = true;
            cleanup();
            resolve('restarted');
            return;
          }
          if (code === DisconnectReason.loggedOut) {
            done = true;
            cleanup();
            reject(new Error('loggedOut'));
            return;
          }
          done = true;
          cleanup();
          reject(new Error('closed'));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        try { sock.ev.off?.('connection.update', onUpdate); } catch { /* ignore */ }
      };
      sock.ev.on('connection.update', onUpdate);
    });
  }

  // Resolves once the server has answered the handshake with pairing refs
  // (a connection.update carrying a qr). That is the only proof this
  // socket can register a pairing code: requestPairingCode() makes the
  // 8-char code up LOCALLY and only registers it by sending companion_hello
  // to the server. Before the handshake completes that send goes nowhere,
  // so the phone gets no notification and rejects the code as if it were
  // random. Note: connection 'connecting' alone is NOT a gate — Baileys
  // emits it on nextTick before the server answers.
  function waitForConnectable(timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error('connect-timeout'));
      }, timeoutMs);
      const onUpdate = (u) => {
        if (done) return;
        if (u.qr || u.connection === 'open') {
          done = true;
          cleanup();
          resolve('connectable');
          return;
        }
        if (u.connection === 'close') {
          const code = u.lastDisconnect?.error?.output?.statusCode;
          done = true;
          cleanup();
          reject(new Error(code === DisconnectReason.loggedOut ? 'loggedOut' : 'closed'));
          return;
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        try { sock.ev.off?.('connection.update', onUpdate); } catch { /* ignore */ }
      };
      sock.ev.on('connection.update', onUpdate);
    });
  }

  return { sock, creds, persist, waitForOpen, waitForConnectable, disconnect, hadStored };
}
