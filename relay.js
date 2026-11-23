'use strict';
/**
 * muse-relay — Relay bot WhatsApp untuk 2 Muse ngobrol & kerja bareng.
 *
 * Cara kerja (lihat protocol.md untuk detail lengkap):
 *   Muse A tulis pesan ke outbox-a.jsonl  -> relay kirim ke nomor B
 *   Muse B tulis pesan ke outbox-b.jsonl  -> relay kirim ke nomor A
 *   Pesan masuk ditulis relay ke inbox lawan, dibaca Muse-nya.
 *
 * Mode grup (baru): Ivan bikin grup WA berisi kedua nomor. Pesan OWNER
 * (nomor utama Ivan) di grup diteruskan relay ke inbox KEDUA Muse
 * (from: "owner") — jadi Ivan bisa perintah/kontrol dua Muse dari satu
 * grup. Balasan tiap Muse (outbox) dikirim relay ke grup JUGA (tambahan,
 * bukan pengganti DM lawan). Pesan grup dari peserta bukan owner diabaikan.
 * JID grup diisi di config.group.groupJid, atau auto-detect di live mode
 * (grup pertama yang berisi A+B). Di dry-run, grup disimulasikan lewat
 * file data/group-incoming.jsonl (pesan masuk) & data/group.jsonl
 * (transkrip pesan keluar ke grup).
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
 *   node relay.js [--mode dry-run|live] [--pairing-code] [--config ./config.json]
 *
 * Pairing:
 *   - Default (QR): QR muncul di terminal, di-scan dari WhatsApp
 *     (Perangkat tertaut > Tautkan perangkat). Butuh kamera + layar lain
 *     kalau QR-nya tampil di HP yang sama.
 *   - --pairing-code: tanpa kamera — relay mencetak kode pairing 8 karakter
 *     per nomor; kode itu dimasukkan di WhatsApp nomor tersebut
 *     (Perangkat tertaut > Tautkan perangkat > "Tautkan dengan nomor
 *     telepon"). Cocok kalau QR tampil di HP yang sama dengan WA-nya.
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
// Pairing tanpa kamera: kode 8 karakter, dimasukkan manual di WhatsApp.
const PAIRING_CODE = argv.includes('--pairing-code');

const resolve = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const SIDES = {
  A: config.museA,
  B: config.museB,
};
const OTHER = { A: 'B', B: 'A' };

// --- Mode grup ---------------------------------------------------------------
// group.enabled   : false = mode grup mati total (DM A<->B tetap jalan).
// group.groupJid  : JID grup WA, mis. "1203630xxxxxxxxx@g.us". Kosong ("") =
//                   auto-detect di live mode (grup pertama yang berisi A+B);
//                   di dry-run dipakai grup virtual "group-dry-run@g.us".
// group.ownerNumber: nomor WA owner (Ivan). Kosong ("") = nomor Muse A.
const GROUP_CFG = config.group || {};
const GROUP_ENABLED = GROUP_CFG.enabled !== false;
const OWNER_JID = jidOf(GROUP_CFG.ownerNumber || SIDES.A.number);
const DRY_RUN_GROUP_JID = 'group-dry-run@g.us';
let groupJid = GROUP_CFG.groupJid || null; // null = belum diketahui (auto-detect)
const GROUP_FILE = resolve('data/group.jsonl'); // transkrip pesan keluar ke grup
const GROUP_INCOMING_FILE = resolve('data/group-incoming.jsonl'); // injeksi pesan grup (dry-run)
const GROUP_CURSOR_FILE = path.join(ROOT, 'data/.group-cursor.json');
// Pesan grup yang sudah diproses (dedup antar 2 sesi Baileys + restart file).
const seenGroupIds = new Set();
// ID pesan WA yang relay sendiri kirim ke grup (anti-gema: jangan proses
// ulang pesan sendiri yang kembali lewat sesi lawan).
const ownGroupWaIds = new Set();
function rememberOwnGroupWaId(id) {
  if (!id) return;
  ownGroupWaIds.add(id);
  if (ownGroupWaIds.size > 1000) ownGroupWaIds.delete(ownGroupWaIds.values().next().value);
}
// Fallback anti-gema (kalau sendMessage tidak mengembalikan WA id):
// teks yang baru saja relay kirim ke grup (jendela 15 dtk).
const recentGroupSent = []; // {senderJid, text, at}
function rememberGroupSent(senderJid, text) {
  recentGroupSent.push({ senderJid, text, at: Date.now() });
  while (recentGroupSent.length > 50) recentGroupSent.shift();
}
function isRecentGroupEcho(senderJid, text) {
  const now = Date.now();
  return recentGroupSent.some((r) => r.senderJid === senderJid && r.text === text && now - r.at < 15000);
}
function currentGroupJid() {
  if (groupJid) return groupJid;
  if (MODE === 'dry-run') return DRY_RUN_GROUP_JID;
  return null;
}
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

// Normalisasi JID ke bentuk nomor HP "digits@s.whatsapp.net".
// Mengembalikan null kalau input bukan nomor HP (mis. LID "@lid").
// Terima JID lengkap ("6285...@s.whatsapp.net", buang sufiks device ":5")
// maupun nomor polos ("6285..."). Dipakai untuk participantPn & p.jid.
// WhatsApp kini sering memakai LID (@lid) sebagai identitas peserta grup;
// tanpa normalisasi ini, perbandingan dengan OWNER_JID (nomor HP) gagal.
function asPhoneJid(jid) {
  if (!jid || typeof jid !== 'string') return null;
  let s = jid.trim();
  if (!s) return null;
  if (!s.includes('@')) {
    // Nomor polos tanpa sufiks — terima hanya kalau murni digit.
    if (!/^\d+$/.test(s)) return null;
    return s + '@s.whatsapp.net';
  }
  if (!s.endsWith('@s.whatsapp.net')) return null;
  const user = s.slice(0, s.indexOf('@')).split(':')[0]; // buang sufiks device ":5"
  if (!/^\d+$/.test(user)) return null;
  return user + '@s.whatsapp.net';
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
// Mode grup: pesan grup WA -> inbox kedua Muse (hanya dari OWNER)
// ---------------------------------------------------------------------------
// Satu-satunya jalan perintah owner masuk: pesan di grup dari nomor owner.
// Return: 'disabled' | 'not-our-group' | 'empty' | 'duplicate' |
//         'ignored-own-echo' | 'ignored-non-owner' | 'delivered-owner'.
function handleGroupMessage({ id, senderJid, remoteJid, text, ts, waId }) {
  if (!GROUP_ENABLED) return 'disabled';
  const gid = currentGroupJid();
  if (remoteJid && gid && remoteJid !== gid) return 'not-our-group';
  if (!text || !String(text).trim()) return 'empty';
  if (!id) id = `grp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  if (seenGroupIds.has(id)) return 'duplicate';
  // Anti-gema: pesan yang relay sendiri kirim ke grup jangan diproses ulang
  // saat kembali lewat sesi Baileys lawan (pengirimnya nomor Muse = owner).
  if (waId && ownGroupWaIds.has(waId)) return 'ignored-own-echo';
  if (isRecentGroupEcho(senderJid, text)) return 'ignored-own-echo';
  seenGroupIds.add(id);
  if (senderJid !== OWNER_JID) {
    info(`[grup] pesan dari ${senderJid} diabaikan (bukan owner)`);
    return 'ignored-non-owner';
  }
  const via = MODE === 'dry-run' ? 'dry-run-group' : 'whatsapp-group';
  const base = {
    id, from: 'owner', text, ts: ts || Date.now(),
    receivedAt: Date.now(), receivedAtIso: nowIso(),
    via, group: true, groupJid: gid || undefined,
  };
  for (const side of ['A', 'B']) {
    appendJsonl(resolve(SIDES[side].inbox), { ...base, to: side });
  }
  if (spaceSync && spaceSync.enabled) {
    for (const side of ['A', 'B']) {
      spaceSync.pushMessage({ ...base, to: side }).catch(() => {});
    }
  }
  info(`[grup] perintah owner -> inbox A + inbox B (${id}): ${String(text).slice(0, 80)}`);
  return 'delivered-owner';
}

// Kirim pesan outbox ke grup JUGA (tambahan, bukan pengganti DM lawan).
// Best-effort: gagal kirim ke grup tidak menggagalkan pengiriman DM.
async function sendToGroup(fromSide, msg) {
  if (!GROUP_ENABLED) return;
  const gid = currentGroupJid();
  if (!gid) { warn('[grup] belum ada JID grup (buat grup berisi A+B dulu) — pesan hanya terkirim via DM'); return; }
  if (MODE === 'dry-run') {
    appendJsonl(GROUP_FILE, { id: msg.id, from: msg.from, to: 'group', text: msg.text, ts: msg.ts, groupJid: gid, via: 'dry-run-group' });
    rememberGroupSent(jidOf(SIDES[fromSide].number), msg.text);
    return;
  }
  const sock = fromSide === 'A' ? sockA : sockB;
  if (!sock) throw new Error(`sesi ${fromSide} belum terhubung (grup)`);
  const sentMsg = await sock.sendMessage(gid, { text: msg.text });
  if (sentMsg && sentMsg.key && sentMsg.key.id) rememberOwnGroupWaId(sentMsg.key.id);
  rememberGroupSent(jidOf(SIDES[fromSide].number), msg.text);
}

// Dry-run: baca pesan grup masuk dari data/group-incoming.jsonl (injeksi tes).
// Format tiap baris: {"id":"...","senderJid":"...@s.whatsapp.net","text":"...","ts":...}
// Di live mode file ini diabaikan (sumber pesan grup = event Baileys).
let groupCursor = loadJson(GROUP_CURSOR_FILE, { pos: 0 }).pos || 0;
function pollGroupIncoming() {
  if (!GROUP_ENABLED || MODE !== 'dry-run') return;
  if (!fs.existsSync(GROUP_INCOMING_FILE)) return;
  const size = fs.statSync(GROUP_INCOMING_FILE).size;
  if (groupCursor > size) groupCursor = 0;
  if (groupCursor === size) return;
  const chunk = fs.readFileSync(GROUP_INCOMING_FILE).subarray(groupCursor).toString('utf8');
  groupCursor = size;
  saveJson(GROUP_CURSOR_FILE, { pos: groupCursor });
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let m;
    try { m = JSON.parse(trimmed); } catch (_) { warn(`baris bukan JSON di group-incoming.jsonl, dilewati: ${trimmed.slice(0, 80)}`); continue; }
    if (!m.text) { warn('pesan grup tanpa text, dilewati'); continue; }
    handleGroupMessage({ id: m.id, senderJid: m.senderJid, remoteJid: m.remoteJid, text: m.text, ts: m.ts, waId: m.waId });
  }
}

// Live mode: cari grup pertama yang berisi nomor A DAN nomor B.
// Dipanggil berkala sampai ketemu (grup bisa dibuat setelah relay start).
let detectingGroup = false;
let lastDetectAttempt = 0;
async function detectGroup() {
  if (!GROUP_ENABLED || MODE !== 'live' || groupJid || detectingGroup) return;
  if (Date.now() - lastDetectAttempt < 60000) return;
  lastDetectAttempt = Date.now();
  detectingGroup = true;
  try {
    // Coba kedua sesi (sockA dulu, lalu sockB) — groupFetchAllParticipating
    // kadang gagal "Connection Closed" di satu sesi padahal sesi lain sehat.
    const socks = [sockA, sockB].filter(Boolean);
    let groups = null;
    let lastErr = null;
    for (const sock of socks) {
      if (typeof sock.groupFetchAllParticipating !== 'function') continue;
      try {
        groups = await sock.groupFetchAllParticipating();
        break;
      } catch (e) { lastErr = e; }
    }
    if (!groups) {
      if (lastErr) warn(`[grup] auto-detect gagal: ${lastErr.message}`);
      return;
    }
    const jidA = jidOf(SIDES.A.number);
    const jidB = jidOf(SIDES.B.number);
    // Peserta bisa terdaftar sebagai LID (p.id = "...@lid") — cocokkan juga
    // lewat p.jid (JID nomor HP) yang disediakan Baileys di objek Contact.
    const phoneOf = (p) => {
      if (!p) return null;
      if (typeof p === 'string') return asPhoneJid(p);
      return asPhoneJid(p.jid) || asPhoneJid(p.id);
    };
    const found = Object.values(groups || {})
      .filter((g) => g && Array.isArray(g.participants))
      .filter((g) => g.participants.some((p) => phoneOf(p) === jidA)
        && g.participants.some((p) => phoneOf(p) === jidB))
      .sort((x, y) => String(x.id).localeCompare(String(y.id)))[0];
    if (found) {
      groupJid = found.id;
      info(`[grup] auto-detect: grup ditemukan ${groupJid} ("${found.subject || ''}") — perintah owner di grup ini diteruskan ke kedua Muse`);
    }
  } catch (e) {
    warn(`[grup] auto-detect gagal: ${e.message}`);
  } finally {
    detectingGroup = false;
  }
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
// Resolver + janji "sisi ini sudah terhubung (connection open)" — dipakai
// mode pairing-code supaya pairing berjalan SATU nomor dulu, baru nomor
// berikutnya (dua kode sekaligus bikin gampang ketuker kode A/B).
const sideOpenResolvers = {};
const sideOpenPromises = {};
// Tunggu satu sisi terhubung, maks timeoutMs; kalau lewat, lanjut saja
// (sisi itu bisa dicoba lagi belakangan, relay tidak macet nunggu).
async function waitSideOpen(side, timeoutMs) {
  const p = sideOpenPromises[side];
  if (!p) return false;
  const ok = await Promise.race([
    p.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  if (!ok) warn(`[live:${side}] belum terhubung setelah ${Math.round(timeoutMs / 1000)} dtk — lanjut ke sisi berikutnya, coba pairing sisi ini lagi nanti.`);
  return ok;
}

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
  // Mode pairing-code: tanpa kamera — kode 8 karakter dimasukkan di
  // WhatsApp (Perangkat tertaut > Tautkan perangkat > "Tautkan dengan
  // nomor telepon"). Kode diminta saat socket masuk state pairing (event
  // QR), lalu di-refresh tiap 40 dtk sampai sisi ini terhubung — jadi
  // selalu ada kode segar (kode pairing cepat kedaluwarsa, ~1 menit).
  // Hanya untuk sesi yang belum terdaftar.
  let pairingTimer = null;
  let pairingBusy = false;
  const stopPairingRefresh = () => { if (pairingTimer) { clearInterval(pairingTimer); pairingTimer = null; } };
  async function requestPairingCodeOnce() {
    if (pairingBusy) return;
    pairingBusy = true;
    try {
      const phone = String(cfg.number).replace(/[^0-9]/g, '');
      const code = await sock.requestPairingCode(phone);
      const appName = side === 'A' ? 'WhatsApp BIASA (nomor utama)' : 'WhatsApp BUSINESS (nomor kedua)';
      info(`[live:${side}] KODE PAIRING TERBARU nomor ${cfg.number}: ${code} (berlaku ~1 menit, pakai kode ini)`);
      info(`[live:${side}] masukkan kode itu di ${appName}: Perangkat tertaut > Tautkan perangkat > "Tautkan dengan nomor telepon" (tanpa scan QR).`);
    } catch (e) {
      error(`[live:${side}] gagal minta kode pairing: ${e.message} — pakai QR (jalankan tanpa --pairing-code).`);
    } finally {
      pairingBusy = false;
    }
  }
  function startPairingRefresh() {
    if (pairingTimer || state.creds.registered) return;
    requestPairingCodeOnce();
    pairingTimer = setInterval(requestPairingCodeOnce, 40000);
  }
  // Fallback: kalau event QR tidak muncul dalam 10 dtk, minta kode sekali.
  if (PAIRING_CODE && !state.creds.registered) {
    setTimeout(startPairingRefresh, 10000);
  }
  // Janji "sisi ini terhubung": resolve saat connection open (sekali saja).
  const openPromise = new Promise((resolve) => { sideOpenResolvers[side] = resolve; });
  sideOpenPromises[side] = openPromise;
  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      if (PAIRING_CODE) {
        startPairingRefresh();
      } else {
        info(`[live:${side}] scan QR ini dengan WhatsApp nomor ${cfg.number} (sekali saja, pairing manual):`);
        try { require('qrcode-terminal').generate(qr, { small: true }); }
        catch (_) { console.log(qr); }
      }
    }
    if (connection === 'open') {
      stopPairingRefresh();
      info(`[live:${side}] terhubung sebagai ${cfg.number}`);
      if (sideOpenResolvers[side]) { sideOpenResolvers[side](); delete sideOpenResolvers[side]; }
    }
    if (connection === 'close') {
      stopPairingRefresh();
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
      if (!m.message) continue;
      const text = m.message.conversation
        || (m.message.extendedTextMessage && m.message.extendedTextMessage.text)
        || '';
      if (!text) continue;
      const fromJid = m.key.remoteJid || '';
      // Pesan GRUP: ditangani handleGroupMessage (SEBELUM skip fromMe —
      // pesan owner dari nomor A terlihat sebagai fromMe di sesi A, tapi
      // sebagai pesan biasa di sesi B; dedup by id di handleGroupMessage).
      if (fromJid.endsWith('@g.us')) {
        // Tentukan pengirim grup. Urutan (paling andal dulu):
        // 1) fromMe — Baileys sudah menangani dual identitas PN/LID untuk
        //    fromMe, jadi pesan owner dari nomor A selalu dikenali di sesi A
        //    walau participant-nya berupa LID. Ini jalur utama.
        // 2) participantPn (nomor HP pengirim) — kalau ada.
        // 3) participant — fallback (bisa LID, tidak cocok dengan OWNER_JID).
        let senderJid;
        if (m.key.fromMe) {
          senderJid = jidOf(cfg.number);
        } else {
          senderJid = asPhoneJid(m.key.participantPn) || m.key.participant || fromJid;
        }
        handleGroupMessage({
          id: m.key.id || `wa-${Date.now()}`,
          senderJid, remoteJid: fromJid, text,
          ts: (m.messageTimestamp || Date.now() / 1000) * 1000,
          waId: m.key.id,
        });
        continue;
      }
      if (m.key.fromMe) continue; // abaikan pesan kiriman sendiri (DM)
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
      // Mode grup: balasan Muse juga muncul di grup (tambahan, bukan pengganti DM).
      try { await sendToGroup(side, msg); }
      catch (e) { warn(`[grup] kirim ${msg.id} ke grup gagal (DM tetap terkirim): ${e.message}`); }
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
    group: { enabled: GROUP_ENABLED, groupJid: currentGroupJid(), detected: Boolean(groupJid) },
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
  if (GROUP_ENABLED) {
    info(`mode grup AKTIF (owner ${OWNER_JID}, grup ${groupJid || (MODE === 'dry-run' ? DRY_RUN_GROUP_JID + ' (virtual)' : 'auto-detect saat live')})`);
  } else {
    info('mode grup NONAKTIF (config.group.enabled=false) — hanya DM A<->B');
  }
  info(`poll tiap ${POLL_MS}ms, heartbeat tiap ${HEARTBEAT_MS}ms`);

  if (MODE === 'live') {
    try {
      baileys = require('@whiskeysockets/baileys');
    } catch (e) {
      error('Baileys belum terinstal. Jalankan: npm install');
      process.exit(1);
    }
    info(PAIRING_CODE
      ? 'live mode: menghubungkan 2 sesi Baileys (kode pairing 8 karakter per nomor, tanpa scan QR)...'
      : 'live mode: menghubungkan 2 sesi Baileys (QR muncul sekali per nomor saat pairing)...');
    if (PAIRING_CODE) {
      // Pairing SEQUENTIAL: satu nomor dulu sampai terhubung, baru nomor
      // berikutnya — supaya cuma ada SATU kode di layar dan tidak ketuker
      // kode A/B (penyebab gagal paling umum: kode A diketik di aplikasi
      // nomor B atau sebaliknya). Timeout 3 menit per sisi, lalu lanjut.
      info('[live] pairing SEQUENTIAL: selesaikan nomor A dulu, baru nomor B. Cuma satu kode yang tampil dalam satu waktu.');
      sockA = await connectSide('A');
      await waitSideOpen('A', 180000);
      sockB = await connectSide('B');
      await waitSideOpen('B', 180000);
    } else {
      sockA = await connectSide('A');
      sockB = await connectSide('B');
    }
  } else {
    info('dry-run mode: tanpa WhatsApp. Pesan outbox langsung diteruskan ke inbox lawan (simulasi file-ke-file).');
  }

  writeHeartbeat();
  hbTimer = setInterval(writeHeartbeat, HEARTBEAT_MS);
  pollTimer = setInterval(async () => {
    try {
      await pollOutbox('A');
      await pollOutbox('B');
      pollGroupIncoming();
      await detectGroup();
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
