'use strict';
/**
 * muse-relay — Relay bot WhatsApp untuk 2 Muse ngobrol & kerja bareng.
 *
 * Cara kerja (lihat protocol.md untuk detail lengkap):
 *   Muse A tulis pesan ke outbox-a.jsonl  -> relay kirim ke nomor B
 *   Muse B tulis pesan ke outbox-b.jsonl  -> relay kirim ke nomor A
 *   Pesan masuk ditulis relay ke inbox lawan, dibaca Muse-nya.
 *
 * Mode:
 *   dry-run : tanpa WhatsApp sama sekali. Pesan outbox A langsung ditulis
 *             ke inbox B (dan sebaliknya) dengan penanda dry-run. Untuk
 *             tes tanpa nomor asli / tanpa kredensial.
 *   live    : dua sesi Baileys (satu per nomor). Pairing QR sekali di awal
 *             oleh pemilik nomor (LANGKAH MANUAL — jangan di VM ini).
 *
 * Baileys hanya di-require saat mode live, jadi dry-run jalan tanpa
 * library WhatsApp terinstal.
 *
 * Usage:
 *   node relay.js [--mode dry-run|live] [--config ./config.json]
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config & CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}
const CONFIG_PATH = path.resolve(flagValue('--config') || './config.json');
const ROOT = path.dirname(CONFIG_PATH);

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`[relay] config tidak ditemukan: ${CONFIG_PATH}`);
  console.error('[relay] salin dulu: cp config.example.json config.json lalu isi nomor WA.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const MODE = flagValue('--mode') || config.mode || 'dry-run';
if (!['dry-run', 'live'].includes(MODE)) {
  console.error(`[relay] mode tidak dikenal: ${MODE} (pakai dry-run atau live)`);
  process.exit(1);
}

const resolve = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const SIDES = {
  A: config.museA,
  B: config.museB,
};
const OTHER = { A: 'B', B: 'A' };
const LOG_FILE = resolve(config.logFile || 'data/relay.log');
const CURSOR_FILE = path.join(ROOT, 'data/.cursor.json');
const SENT_FILE = path.join(ROOT, 'data/sent.json');
const FAILED_FILE = resolve('data/failed.jsonl');
const DELIVERED_FILE = resolve('data/delivered.jsonl');
const HEARTBEAT_FILE = resolve(config.heartbeatFile || 'data/heartbeat.json');
const PID_FILE = resolve(config.pidFile || 'data/relay.pid');
const POLL_MS = config.pollMs || 2000;
const HEARTBEAT_MS = config.heartbeatMs || 60000;
const MAX_ATTEMPTS = (config.retry && config.retry.maxAttempts) || 5;
const BASE_DELAY_MS = (config.retry && config.retry.baseDelayMs) || 5000;

for (const dir of ['data', 'auth']) fs.mkdirSync(path.join(ROOT, dir), { recursive: true });

// Sync opsional ke Space monitor (nonaktif kalau space.ingestUrl kosong).
let spaceSync = null;
try { spaceSync = require('./space-sync'); } catch (_) { spaceSync = null; }

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) { /* log file opsional */ }
}
const info = (m) => log('INFO', m);
const warn = (m) => log('WARN', m);
const error = (m) => log('ERROR', m);

// ---------------------------------------------------------------------------
// State di disk (cursor outbox + id pesan yang sudah terkirim)
// ---------------------------------------------------------------------------
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function saveJson(file, obj) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 2));
  fs.renameSync(file + '.tmp', file);
}
let cursor = loadJson(CURSOR_FILE, { A: 0, B: 0 });
let sentIds = new Set(loadJson(SENT_FILE, []));
const saveCursor = () => saveJson(CURSOR_FILE, cursor);
const saveSent = () => saveJson(SENT_FILE, [...sentIds]);

function appendJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}
function nowIso() { return new Date().toISOString(); }
function jidOf(number) {
  return number.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
}

// ---------------------------------------------------------------------------
// Kirim pesan masuk ke inbox lawan (dipakai dry-run & live)
// ---------------------------------------------------------------------------
function deliverToInbox(toSide, msg, via) {
  const record = {
    id: msg.id,
    from: msg.from,
    to: msg.to,
    text: msg.text,
    ts: msg.ts,
    receivedAt: Date.now(),
    receivedAtIso: nowIso(),
    via, // 'dry-run' | 'whatsapp'
  };
  appendJsonl(resolve(SIDES[toSide].inbox), record);
  if (spaceSync && spaceSync.enabled) {
    spaceSync.pushMessage(record).then((ok) => { if (!ok) warn('space-sync pesan gagal (relay tetap jalan)'); }).catch(() => {});
  }
  return record;
}

// ---------------------------------------------------------------------------
// Antrean retry (live mode): kirim gagal dicoba lagi dengan backoff
// ---------------------------------------------------------------------------
const retryQueue = []; // {msg, attempts, nextTryAt}
function scheduleRetry(msg) {
  const attempts = (msg._attempts || 0) + 1;
  if (attempts > MAX_ATTEMPTS) {
    appendJsonl(FAILED_FILE, { ...msg, failedAt: Date.now(), failedAtIso: nowIso(), attempts });
    error(`GAGAL kirim ${msg.id} setelah ${MAX_ATTEMPTS}x percobaan -> data/failed.jsonl (pindahkan barisnya kembali ke outbox untuk requeue)`);
    return;
  }
  const delay = BASE_DELAY_MS * Math.pow(2, attempts - 1);
  retryQueue.push({ msg: { ...msg, _attempts: attempts }, nextTryAt: Date.now() + delay });
  warn(`Kirim ${msg.id} gagal (percobaan ${attempts}/${MAX_ATTEMPTS}), coba lagi dalam ${Math.round(delay / 1000)} dtk`);
}

// ---------------------------------------------------------------------------
// Live mode: dua sesi Baileys
// ---------------------------------------------------------------------------
let sockA = null;
let sockB = null;
let baileys = null;

async function connectSide(side) {
  const cfg = SIDES[side];
  const { state, saveCreds } = await baileys.useMultiFileAuthState(resolve(cfg.sessionDir));
  const { version } = await baileys.fetchLatestBaileysVersion();
  const pino = require('pino');
  const sock = baileys.default({
    auth: state,
    version,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['muse-relay', 'Chrome', '1.0.0'],
  });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      info(`[live:${side}] scan QR ini dengan WhatsApp nomor ${cfg.number} (sekali saja, pairing manual):`);
      try { require('qrcode-terminal').generate(qr, { small: true }); }
      catch (_) { console.log(qr); }
    }
    if (connection === 'open') info(`[live:${side}] terhubung sebagai ${cfg.number}`);
    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode : '?';
      warn(`[live:${side}] koneksi putus (code ${code}). Reconnect otomatis...`);
      if (code !== 401) { // 401 = logged out -> butuh pairing ulang manual
        setTimeout(() => connectSide(side).catch((e) => error(`[live:${side}] reconnect gagal: ${e.message}`)), 5000);
      } else {
        error(`[live:${side}] LOGGED OUT (401). Hapus ${cfg.sessionDir} lalu pairing ulang manual.`);
      }
    }
  });
  // Pesan masuk -> inbox sisi ini (Muse pemilik nomor ini yang baca).
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue; // abaikan pesan kiriman sendiri
      const text = m.message.conversation
        || (m.message.extendedTextMessage && m.message.extendedTextMessage.text)
        || '';
      if (!text) continue;
      const fromJid = m.key.remoteJid || '';
      const record = {
        id: m.key.id || `wa-${Date.now()}`,
        from: fromJid === jidOf(SIDES.A.number) ? 'A' : fromJid === jidOf(SIDES.B.number) ? 'B' : fromJid,
        to: side,
        text,
        ts: (m.messageTimestamp || Date.now() / 1000) * 1000,
        receivedAt: Date.now(),
        receivedAtIso: nowIso(),
        via: 'whatsapp',
      };
      appendJsonl(resolve(cfg.inbox), record);
      info(`[live:${side}] pesan masuk dari ${record.from} -> inbox-${side.toLowerCase()} (${text.slice(0, 60)}...)`);
    }
  });
  return sock;
}

async function sendLive(fromSide, msg) {
  const sock = fromSide === 'A' ? sockA : sockB;
  const toSide = OTHER[fromSide];
  const toNumber = SIDES[toSide].number;
  if (!sock) throw new Error(`sesi ${fromSide} belum terhubung`);
  await sock.sendMessage(jidOf(toNumber), { text: msg.text });
}

// ---------------------------------------------------------------------------
// Poll outbox -> kirim (dry-run: langsung ke inbox lawan)
// ---------------------------------------------------------------------------
async function pollOutbox(side) {
  const cfg = SIDES[side];
  const file = resolve(cfg.outbox);
  if (!fs.existsSync(file)) return;
  const size = fs.statSync(file).size;
  if (cursor[side] > size) cursor[side] = 0; // file di-rotate/truncate
  if (cursor[side] === size) return;
  const buf = fs.readFileSync(file);
  const chunk = buf.subarray(cursor[side]).toString('utf8');
  cursor[side] = size;
  saveCursor();
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try { msg = JSON.parse(trimmed); } catch (_) { warn(`baris bukan JSON di outbox-${side.toLowerCase()}, dilewati: ${trimmed.slice(0, 80)}`); continue; }
    if (!msg.id || !msg.text) { warn(`pesan tanpa id/text di outbox-${side.toLowerCase()}, dilewati`); continue; }
    if (sentIds.has(msg.id)) continue; // sudah terkirim (restart-safe)
    if (msg.from !== side) { warn(`pesan ${msg.id} di outbox-${side.toLowerCase()} punya from=${msg.from}, dilewati`); continue; }
    try {
      if (MODE === 'dry-run') {
        deliverToInbox(OTHER[side], msg, 'dry-run');
      } else {
        await sendLive(side, msg);
        deliverToInbox(OTHER[side], { ...msg, deliveredVia: 'whatsapp' }, 'whatsapp');
      }
      sentIds.add(msg.id);
      saveSent();
      appendJsonl(DELIVERED_FILE, { ...msg, deliveredAt: Date.now(), deliveredAtIso: nowIso(), via: MODE });
      info(`[${MODE}] ${msg.from} -> ${msg.to} terkirim (${msg.id}): ${String(msg.text).slice(0, 80)}`);
    } catch (e) {
      error(`kirim ${msg.id} gagal: ${e.message}`);
      if (MODE === 'live') scheduleRetry(msg);
      else warn(`dry-run gagal (aneh) — pesan ${msg.id} tidak ditandai terkirim, akan dicoba lagi poll berikut`);
    }
  }
}

async function pollRetryQueue() {
  if (MODE !== 'live') return;
  const now = Date.now();
  for (let i = retryQueue.length - 1; i >= 0; i--) {
    const item = retryQueue[i];
    if (item.nextTryAt > now) continue;
    retryQueue.splice(i, 1);
    try {
      await sendLive(item.msg.from, item.msg);
      deliverToInbox(OTHER[item.msg.from], { ...item.msg, deliveredVia: 'whatsapp' }, 'whatsapp');
      sentIds.add(item.msg.id);
      saveSent();
      appendJsonl(DELIVERED_FILE, { ...item.msg, deliveredAt: Date.now(), deliveredAtIso: nowIso(), via: 'live-retry' });
      info(`[live-retry] ${item.msg.id} terkirim setelah ${item.msg._attempts}x percobaan`);
    } catch (e) {
      error(`retry ${item.msg.id} gagal lagi: ${e.message}`);
      scheduleRetry(item.msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Heartbeat (tiap 1 menit) — Space baca ini untuk status hidup/mati
// ---------------------------------------------------------------------------
function lastActivity(side) {
  const inbox = resolve(SIDES[side].inbox);
  const outbox = resolve(SIDES[side].outbox);
  let last = 0;
  for (const f of [inbox, outbox]) {
    try {
      const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
      if (!lines.length) continue;
      const lastMsg = JSON.parse(lines[lines.length - 1]);
      if (lastMsg.ts && lastMsg.ts > last) last = lastMsg.ts;
    } catch (_) { /* file kosong/belum ada */ }
  }
  return last;
}
function writeHeartbeat() {
  const hb = {
    relay: { pid: process.pid, mode: MODE, startedAt: STARTED_AT, lastTick: Date.now(), lastTickIso: nowIso() },
    A: { name: SIDES.A.name, lastActivity: lastActivity('A') },
    B: { name: SIDES.B.name, lastActivity: lastActivity('B') },
  };
  saveJson(HEARTBEAT_FILE, hb);
  if (spaceSync && spaceSync.enabled) {
    spaceSync.pushHeartbeat(hb).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const STARTED_AT = Date.now();
let pollTimer = null;
let hbTimer = null;

async function main() {
  fs.writeFileSync(PID_FILE, String(process.pid));
  info(`muse-relay mulai (mode=${MODE}, pid=${process.pid})`);
  info(`Muse A: ${SIDES.A.name} ${SIDES.A.number} | Muse B: ${SIDES.B.name} ${SIDES.B.number}`);
  info(`poll tiap ${POLL_MS}ms, heartbeat tiap ${HEARTBEAT_MS}ms`);

  if (MODE === 'live') {
    try {
      baileys = require('@whiskeysockets/baileys');
    } catch (e) {
      error('Baileys belum terinstal. Jalankan: npm install');
      process.exit(1);
    }
    info('live mode: menghubungkan 2 sesi Baileys (QR muncul sekali per nomor saat pairing)...');
    sockA = await connectSide('A');
    sockB = await connectSide('B');
  } else {
    info('dry-run mode: tanpa WhatsApp. Pesan outbox langsung diteruskan ke inbox lawan (simulasi file-ke-file).');
  }

  writeHeartbeat();
  hbTimer = setInterval(writeHeartbeat, HEARTBEAT_MS);
  pollTimer = setInterval(async () => {
    try {
      await pollOutbox('A');
      await pollOutbox('B');
      await pollRetryQueue();
    } catch (e) { error(`poll error: ${e.message}`); }
  }, POLL_MS);

  const shutdown = (sig) => {
    info(`menerima ${sig}, berhenti dengan rapi...`);
    clearInterval(pollTimer);
    clearInterval(hbTimer);
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => { error(`fatal: ${e.stack || e.message}`); process.exit(1); });
