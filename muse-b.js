'use strict';
/**
 * muse-b.js — Mikasa (Agent B): worker yang membaca inbox-b dan membalas
 * via outbox-b.
 *
 * Cara kerja:
 *   - Poll data/inbox-b.jsonl tiap 2 detik (cursor byte offset di
 *     data/.muse-b-state.json, pola sama seperti pollOutbox di relay.js).
 *   - Untuk tiap pesan BARU yang from-nya "owner" atau "A", tulis SATU
 *     balasan ke data/outbox-b.jsonl. Relay yang meneruskannya ke nomor A
 *     via DM dan ke grup (lihat relay.js sendToGroup).
 *   - Diabaikan (tidak dibalas): pesan from "B" (pesan sendiri),
 *     from "status@broadcast", dan via "dry-run" / "dry-run-group"
 *     (simulasi, bukan pesan live).
 *   - Dedup by id: id yang sudah dibalas disimpan di state file, jadi
 *     restart tidak bikin balasan ganda.
 *
 * Balasan v1 ini TEMPLATE KONTEKSTUAL (bukan LLM): Mikasa mengenali
 * sapaan / perintah / obrolan biasa lalu menjawab dengan template Bahasa
 * Indonesia santai gaya lu/gue. Mikasa v1 TIDAK mengakses internet, API,
 * atau tools apa pun — ia hanya membalas dari isi pesan yang dibaca.
 * Upgrade ke LLM API adalah langkah berikut (config env terpisah).
 * Jangan klaim Mikasa mengerjakan sesuatu yang tidak bisa dibuktikan.
 *
 * Usage:
 *   node muse-b.js                  (poll terus, mode live file)
 *   node muse-b.js --once           (proses sekali lalu keluar)
 *   node muse-b.js --dry-run        (baca inbox, log balasan, JANGAN tulis outbox)
 *   node muse-b.js --once --dry-run (kombinasi, untuk tes)
 *   node muse-b.js --config ./config.json
 *
 * Log: data/muse-b.log (format sama seperti relay.js).
 * PID: data/muse-b.pid. State: data/.muse-b-state.json.
 * JANGAN menulis langsung ke outbox lawan atau ke inbox — itu tugas relay.
 * Worker ini TIDAK PERNAH mengirim WhatsApp langsung; hanya tulis outbox.
 */
const fs = require('fs');
const path = require('path');

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const ONCE = argv.includes('--once');
const configPath = path.resolve(flagValue(argv, '--config') || './config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const ROOT = path.dirname(configPath);
const resolve = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const INBOX = resolve(config.museB.inbox);
const OUTBOX = resolve(config.museB.outbox);
const LOG_FILE = path.join(ROOT, 'data/muse-b.log');
const STATE_FILE = path.join(ROOT, 'data/.muse-b-state.json');
const PID_FILE = path.join(ROOT, 'data/muse-b.pid');
const POLL_MS = config.pollMs || 2000;
const NAME = 'Mikasa';

for (const dir of ['data']) fs.mkdirSync(path.join(ROOT, dir), { recursive: true });

// ---------------------------------------------------------------------------
// Logging (format sama seperti relay.js)
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
// State di disk (cursor byte inbox-b + id pesan yang sudah dibalas)
// ---------------------------------------------------------------------------
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function saveJson(file, obj) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 2));
  fs.renameSync(file + '.tmp', file);
}
const state = loadJson(STATE_FILE, { pos: 0, replied: [] });
let cursor = typeof state.pos === 'number' ? state.pos : 0;
const repliedIds = new Set(Array.isArray(state.replied) ? state.replied : []);
const saveState = () => {
  if (DRY_RUN) return; // dry-run: jangan simpan state (tanpa efek samping)
  const replied = [...repliedIds].slice(-500); // batasi biar file tidak membengkak
  saveJson(STATE_FILE, { pos: cursor, replied });
};

function appendJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}
function nowIso() { return new Date().toISOString(); }

// ---------------------------------------------------------------------------
// Balasan Mikasa (template kontekstual, Bahasa Indonesia santai lu/gue)
// ---------------------------------------------------------------------------
function cleanSummary(text, maxLen) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  // Buang sapaan/panggilan di awal ("Mikasa,", "Ivan:", "Halo Mikasa,") biar ringkas.
  s = s.replace(/^(mikasa|ivan|halo mikasa|halo|hai|hi|hei)[,:]?\s*/i, '').trim() || String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).trim() + '...';
  return s;
}

function isGreeting(text) {
  const t = String(text || '').trim().toLowerCase();
  if (t.length > 80) return false;
  // Sapaan murni: hanya nama saja ("Mikasa", "Suneo?") ...
  if (/^(suneo|mikasa)[?!.]*$/.test(t)) return true;
  // ... atau diawali kata sapaan (halo/hai/tes/bls/dsb).
  // CATATAN: "Mikasa, kerjakan ..." BUKAN sapaan — itu perintah yang
  // diawali panggilan nama, jadi "mikasa" tidak masuk daftar awalan ini.
  if (/^(halo|hai|hi|hei|pagi|siang|sore|malam|tes|test|ping|bls|balas)\b/.test(t)) return true;
  if (t.length <= 40 && /\b(halo|hai|selamat (pagi|siang|sore|malam))\b/.test(t)) return true;
  return false;
}

function isTask(text, from) {
  if (from === 'owner') {
    // Perintah owner hampir selalu tugas, kecuali sapaan pendek.
    return !isGreeting(text);
  }
  return /(kerjakan|kerjain|riset|cari|buat|tolong|tugas|cek|pantau|lapor|bagi tugas|siapin|kirim|catat|inget|monitor|analisa|analisis|review|audit|hunt|gas|kerjakan|bantu)/i.test(String(text || ''));
}

/**
 * Susun balasan untuk satu pesan inbox. Mengembalikan string balasan,
 * atau null kalau pesan harus diabaikan (bukan untuk Mikasa).
 */
function composeReply(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const from = msg.from;
  const text = String(msg.text || '').trim();
  if (!text) return null;
  if (from === 'B') return null; // pesan sendiri — jangan balas (anti-loop)
  if (from === 'status@broadcast') return null; // update status WA, bukan pesan
  if (msg.via === 'dry-run' || msg.via === 'dry-run-group') return null; // simulasi
  if (from !== 'owner' && from !== 'A') return null; // hanya owner & Muse A

  if (isGreeting(text)) {
    if (from === 'A') return `Halo A! Gue ${NAME}. Ada apa bro — ada tugas buat gue?`;
    return `Halo bro! Gue ${NAME}, Agent B — siap bantu. Ada tugas apa buat gue?`;
  }
  if (isTask(text, from)) {
    const summary = cleanSummary(text, 120);
    return `Siap bro, gue tangkep tugasnya: "${summary}". Rencana gue: 1) gue baca dulu detail perintahnya, 2) gue susun langkah-langkahnya, 3) gue kabarin hasilnya di sini. Kalau ada info tambahan, kirim aja.`;
  }
  // Obrolan biasa: akui isinya + tawarkan lanjut.
  const summary = cleanSummary(text, 120);
  if (from === 'A') return `Noted, A — gue tangkep: "${summary}". Gue siap lanjutin, tinggal kabarin langkah berikutnya.`;
  return `Siap bro, gue tangkep: "${summary}". Kabarin aja kalau ada langkah lanjutannya.`;
}

// ---------------------------------------------------------------------------
// Poll inbox-b -> balas via outbox-b
// ---------------------------------------------------------------------------
function processInbox() {
  if (!fs.existsSync(INBOX)) return { read: 0, replied: 0, ignored: 0 };
  const size = fs.statSync(INBOX).size;
  if (cursor > size) cursor = 0; // file di-rotate/truncate
  if (cursor === size) return { read: 0, replied: 0, ignored: 0 };
  const buf = fs.readFileSync(INBOX);
  const chunk = buf.subarray(cursor).toString('utf8');
  cursor = size;
  let read = 0;
  let replied = 0;
  let ignored = 0;
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try { msg = JSON.parse(trimmed); } catch (_) { warn(`baris bukan JSON di inbox-b, dilewati: ${trimmed.slice(0, 80)}`); continue; }
    read++;
    if (!msg.id || !msg.text) { warn('pesan tanpa id/text di inbox-b, dilewati'); ignored++; continue; }
    if (repliedIds.has(msg.id)) { ignored++; continue; } // sudah dibalas (restart-safe)
    const reply = composeReply(msg);
    if (reply === null) {
      info(`pesan ${msg.id} dari ${msg.from} diabaikan (bukan untuk dibalas)`);
      repliedIds.add(msg.id);
      ignored++;
      continue;
    }
    const out = {
      id: `B-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      from: 'B',
      to: 'A',
      text: reply,
      ts: Date.now(),
    };
    if (DRY_RUN) {
      info(`[dry-run] balasan untuk ${msg.id} (tidak ditulis): ${reply.slice(0, 100)}`);
    } else {
      try {
        fs.mkdirSync(path.dirname(OUTBOX), { recursive: true });
        appendJsonl(OUTBOX, out);
        info(`balas ${msg.id} -> outbox-b (${out.id}): ${reply.slice(0, 100)}`);
      } catch (e) {
        error(`gagal tulis outbox-b untuk ${msg.id}: ${e.message}`);
        continue;
      }
    }
    repliedIds.add(msg.id);
    replied++;
  }
  saveState();
  return { read, replied, ignored };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch (_) { /* pid opsional */ }
  info(`${NAME} (Agent B) mulai — inbox: ${path.relative(ROOT, INBOX)}, outbox: ${path.relative(ROOT, OUTBOX)}${DRY_RUN ? ' [dry-run]' : ''}${ONCE ? ' [once]' : ''}`);
  const first = processInbox();
  info(`poll pertama: ${first.read} pesan dibaca, ${first.replied} dibalas, ${first.ignored} diabaikan`);
  if (ONCE) {
    info(`${NAME} selesai (--once), keluar.`);
    process.exit(0);
  }
  const timer = setInterval(() => {
    try {
      const r = processInbox();
      if (r.read > 0) info(`poll: ${r.read} pesan dibaca, ${r.replied} dibalas, ${r.ignored} diabaikan`);
    } catch (e) {
      error(`poll gagal: ${e.message}`);
    }
  }, POLL_MS);
  const shutdown = (sig) => {
    clearInterval(timer);
    saveState();
    info(`${NAME} berhenti (${sig}).`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
