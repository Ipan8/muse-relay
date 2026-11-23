'use strict';
/**
 * bridge.js — Jembatan HTTP untuk relay 2 Muse (Suneo/A + Mikasa/B).
 *
 * Masalah yang diselesaikan: Muse asli (Suneo dan Mikasa) jalan di browser
 * (Brave) dan TIDAK PUNYA akses file langsung ke VPS. Jembatan ini memberi
 * mereka akses lewat web: baca inbox + tulis outbox lewat HTTP, tanpa
 * menyentuh file VPS dan tanpa menyentuh WhatsApp.
 *
 *   GET  /inbox-a, /inbox-b   -> pesan yang BELUM dibaca (cursor per sisi)
 *                                (?all=1 untuk semua pesan, tanpa majukan cursor)
 *   POST /outbox-a, /outbox-b -> body JSON {text} (wajib, tidak kosong)
 *                                -> tulis satu baris ke outbox sisi itu
 *   GET  /status              -> status bridge + relay (dari heartbeat.json)
 *
 * Auth: SEMUA endpoint (termasuk /status) wajib header
 *   Authorization: Bearer <RELAY_BRIDGE_TOKEN>
 * Token dibaca dari ENV RELAY_BRIDGE_TOKEN (atau data/bridge.env via service).
 * Kalau token TIDAK diset, server tetap jalan tapi MENOLAK semua request
 * dengan 401 (fail-closed) + log peringatan. JANGAN hardcode token di repo.
 *
 * Port: ENV RELAY_BRIDGE_PORT (default 3000). Listen 0.0.0.0.
 * Server ini jalan sebagai service systemd (bridge.service) di VPS — ia
 * tetap jalan walau browser (Brave) ditutup; browser hanya kliennya.
 *
 * Yang BOLEH diakses: inbox-a/b, outbox-a/b, heartbeat/status. TIDAK PERNAH
 * expose auth/, config.json, atau kredensial apa pun. Endpoint TIDAK
 * menerima path file dari user (jalur file tetap, dari config.json).
 * Bridge TIDAK PERNAH mengirim WhatsApp langsung — hanya tulis outbox;
 * relay yang meneruskannya (ke DM lawan + grup).
 *
 * Usage:
 *   RELAY_BRIDGE_TOKEN=<token> node bridge.js
 *   RELAY_BRIDGE_TOKEN=<token> RELAY_BRIDGE_PORT=3000 node bridge.js
 *   node bridge.js --config ./config.json --port 3000
 *
 * Contoh dari Brave (fetch):
 *   fetch('http://43.128.95.190:3000/inbox-b', {headers:{Authorization:'Bearer TOKEN'}})
 *     .then(r => r.json()).then(console.log)
 *   fetch('http://43.128.95.190:3000/outbox-b', {method:'POST',
 *     headers:{Authorization:'Bearer TOKEN','Content-Type':'application/json'},
 *     body: JSON.stringify({text:'Halo A, ini Mikasa'})}).then(r => r.json())
 *
 * Log: data/bridge.log. PID: data/bridge.pid. Cursor baca: data/.bridge-cursor.json.
 * Cursor per sisi: tiap pesan hanya dikirim sekali sebagai "belum dibaca"
 * (seperti muse-read.js). Pakai ?all=1 untuk baca ulang semua pesan.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STARTED_AT = Date.now();
const MAX_BODY_BYTES = 64 * 1024; // 64 KB — cukup untuk satu pesan
const MAX_TEXT_LEN = 10000;

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function saveJson(file, obj) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 2));
  fs.renameSync(file + '.tmp', file);
}
function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch (_) { return []; }
}
function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function makeId(side) {
  return `${side}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Buat HTTP server bridge. opts: {root, config, port, token}.
 * Dipakai langsung oleh CLI (bawah) dan oleh tes (test/simulate-bridge.js).
 */
function createServer(opts) {
  const root = opts.root;
  const config = opts.config;
  const port = opts.port || 3000;
  const token = opts.token || '';
  const resolve = (p) => (path.isAbsolute(p) ? p : path.join(root, p));
  const inbox = { A: resolve(config.museA.inbox), B: resolve(config.museB.inbox) };
  const outbox = { A: resolve(config.museA.outbox), B: resolve(config.museB.outbox) };
  const heartbeatFile = resolve(config.heartbeatFile || 'data/heartbeat.json');
  const logFile = path.join(root, 'data/bridge.log');
  const cursorFile = path.join(root, 'data/.bridge-cursor.json');

  fs.mkdirSync(path.join(root, 'data'), { recursive: true });

  function log(level, msg) {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    console.log(line);
    try { fs.appendFileSync(logFile, line + '\n'); } catch (_) { /* log file opsional */ }
  }
  const info = (m) => log('INFO', m);
  const warn = (m) => log('WARN', m);

  // Cursor baca per sisi (byte offset di file inbox) — tiap pesan hanya
  // dikirim sekali sebagai "belum dibaca". Terpisah dari cursor muse-read.js
  // dan muse-b.js, jadi tidak saling mengganggu.
  let cursor = loadJson(cursorFile, { A: 0, B: 0 });
  if (typeof cursor.A !== 'number') cursor.A = 0;
  if (typeof cursor.B !== 'number') cursor.B = 0;
  const saveCursor = () => { try { saveJson(cursorFile, cursor); } catch (_) { /* abaikan */ } };

  function readInboxNew(side) {
    const file = inbox[side];
    if (!fs.existsSync(file)) return [];
    const size = fs.statSync(file).size;
    if (cursor[side] > size) cursor[side] = 0; // file di-rotate/truncate
    if (cursor[side] === size) return [];
    const buf = fs.readFileSync(file);
    const chunk = buf.subarray(cursor[side]).toString('utf8');
    cursor[side] = size;
    const msgs = [];
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { msgs.push(JSON.parse(trimmed)); } catch (_) { warn(`baris bukan JSON di inbox-${side.toLowerCase()}, dilewati`); }
    }
    saveCursor();
    return msgs;
  }
  function readInboxAll(side) {
    return readJsonl(inbox[side]);
  }

  function checkAuth(req) {
    if (!token) return false; // token belum diset -> tolak semua (fail-closed)
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/.exec(h);
    return !!m && safeEqual(m[1], token);
  }

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolveBody, reject) => {
      const chunks = [];
      let total = 0;
      let tooBig = false;
      req.on('data', (c) => {
        total += c.length;
        if (total > MAX_BODY_BYTES) { tooBig = true; return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return reject(new Error('body terlalu besar (maks 64 KB)'));
        resolveBody(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    let u;
    try { u = new URL(req.url || '/', 'http://localhost'); } catch (_) { u = new URL('/', 'http://localhost'); }
    const pathname = (u.pathname.replace(/\/+$/, '') || '/');

    // Preflight CORS — tanpa auth (browser butuh ini sebelum kirim Authorization).
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    if (!checkAuth(req)) {
      info(`${req.method} ${pathname} -> 401 (auth gagal / token belum diset)`);
      sendJson(res, 401, { ok: false, error: 'unauthorized: Bearer token salah atau belum diset (RELAY_BRIDGE_TOKEN)' });
      return;
    }

    try {
      if (req.method === 'GET' && (pathname === '/inbox-a' || pathname === '/inbox-b')) {
        const side = pathname === '/inbox-a' ? 'A' : 'B';
        const all = u.searchParams.get('all') === '1';
        const msgs = all ? readInboxAll(side) : readInboxNew(side);
        info(`GET ${pathname}${all ? '?all=1' : ''} -> 200 (${msgs.length} pesan)`);
        sendJson(res, 200, { ok: true, side, messages: msgs });
        return;
      }
      if (req.method === 'GET' && pathname === '/status') {
        const hb = loadJson(heartbeatFile, null);
        sendJson(res, 200, {
          ok: true,
          bridge: { pid: process.pid, port, startedAt: STARTED_AT, uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000) },
          relay: hb && hb.relay ? hb.relay : null,
          A: hb && hb.A ? hb.A : null,
          B: hb && hb.B ? hb.B : null,
          group: hb && hb.group ? hb.group : null,
        });
        info('GET /status -> 200');
        return;
      }
      if (req.method === 'POST' && (pathname === '/outbox-a' || pathname === '/outbox-b')) {
        const side = pathname === '/outbox-a' ? 'A' : 'B';
        const other = side === 'A' ? 'B' : 'A';
        let bodyText = '';
        try { bodyText = await readBody(req); } catch (e) { sendJson(res, 413, { ok: false, error: e.message }); return; }
        let body;
        try { body = JSON.parse(bodyText); } catch (_) { sendJson(res, 400, { ok: false, error: 'body harus JSON' }); return; }
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) { sendJson(res, 400, { ok: false, error: 'field text wajib dan tidak boleh kosong' }); return; }
        if (text.length > MAX_TEXT_LEN) { sendJson(res, 400, { ok: false, error: `text terlalu panjang (maks ${MAX_TEXT_LEN} karakter)` }); return; }
        const msg = { id: makeId(side), from: side, to: other, text, ts: Date.now() };
        appendJsonl(outbox[side], msg);
        info(`POST ${pathname} -> 200 (id ${msg.id}, ${text.length} karakter)`);
        sendJson(res, 200, { ok: true, id: msg.id });
        return;
      }
      info(`${req.method} ${pathname} -> 404`);
      sendJson(res, 404, { ok: false, error: 'endpoint tidak dikenal (pakai /inbox-a, /inbox-b, /outbox-a, /outbox-b, /status)' });
    } catch (e) {
      warn(`${req.method} ${pathname} -> 500 (${e.message})`);
      sendJson(res, 500, { ok: false, error: 'internal error: ' + e.message });
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// CLI entry — jalankan langsung sebagai server
// ---------------------------------------------------------------------------
if (require.main === module) {
  const flagValue = (argv, name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  const argv = process.argv.slice(2);
  const configPath = path.resolve(flagValue(argv, '--config') || './config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const root = path.dirname(configPath);
  const port = parseInt(flagValue(argv, '--port') || process.env.RELAY_BRIDGE_PORT || '3000', 10) || 3000;
  const token = process.env.RELAY_BRIDGE_TOKEN || '';
  const server = createServer({ root, config, port, token });
  try { fs.writeFileSync(path.join(root, 'data/bridge.pid'), String(process.pid)); } catch (_) { /* pid opsional */ }
  server.listen(port, '0.0.0.0', () => {
    const addr = server.address();
    const realPort = addr && addr.port ? addr.port : port;
    console.log(`[bridge] jalan di http://0.0.0.0:${realPort} (token ${token ? 'diset' : 'BELUM DISET — semua request akan 401'})`);
    if (!token) {
      console.log('[bridge] PERINGATAN: RELAY_BRIDGE_TOKEN kosong. Generate token (openssl rand -hex 16), tulis ke data/bridge.env, lalu restart service (sudo systemctl restart bridge).');
    }
  });
  const shutdown = () => { server.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer };
