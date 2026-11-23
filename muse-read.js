'use strict';
/**
 * muse-read.js — Muse membaca pesan baru di inbox-nya sendiri.
 *
 * Usage:
 *   node muse-read.js A            (tampilkan pesan baru di inbox A)
 *   node muse-read.js B --all      (tampilkan SEMUA pesan di inbox B)
 *   node muse-read.js A --config ./config.json
 *
 * Cursor baca disimpan di data/.read-cursor-<side>.json — tiap pesan hanya
 * ditampilkan sekali sebagai "baru". Pakai --all untuk membaca ulang semua.
 * Output: satu baris per pesan: [ISO-time] PENGIRIM: teks
 * Pesan dari manusia (bukan dari Muse lawan) tampil dengan from = JID WA.
 * Perintah owner dari grup tampil dengan from = "owner" (lihat protocol.md).
 */
const fs = require('fs');
const path = require('path');

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

const argv = process.argv.slice(2);
const side = (argv[0] || '').toUpperCase();
if (!['A', 'B'].includes(side)) {
  console.error('Usage: node muse-read.js <A|B> [--all] [--config <path>]');
  process.exit(1);
}
const showAll = argv.includes('--all');
const configPath = path.resolve(flagValue(argv, '--config') || './config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const cfg = side === 'A' ? config.museA : config.museB;
const inbox = path.isAbsolute(cfg.inbox) ? cfg.inbox : path.join(path.dirname(configPath), cfg.inbox);
const cursorFile = path.join(path.dirname(configPath), `data/.read-cursor-${side.toLowerCase()}.json`);

if (!fs.existsSync(inbox)) {
  console.log(`(inbox-${side.toLowerCase()} masih kosong — belum ada pesan masuk)`);
  process.exit(0);
}
const lines = fs.readFileSync(inbox, 'utf8').split('\n').filter((l) => l.trim());
let cursor = 0;
if (!showAll) {
  try { cursor = JSON.parse(fs.readFileSync(cursorFile, 'utf8')).lines || 0; } catch (_) { cursor = 0; }
}
if (cursor > lines.length) cursor = 0;
const fresh = lines.slice(cursor);
if (!fresh.length) {
  console.log('(tidak ada pesan baru)');
  process.exit(0);
}
for (const line of fresh) {
  try {
    const m = JSON.parse(line);
    const t = m.ts ? new Date(m.ts).toISOString() : '?';
    console.log(`[${t}] ${m.from} -> ${m.to}: ${m.text}`);
  } catch (_) {
    console.log(`(baris rusak dilewati: ${line.slice(0, 80)})`);
  }
}
if (!showAll) {
  fs.writeFileSync(cursorFile, JSON.stringify({ lines: lines.length, readAt: Date.now() }));
  console.log(`--- ${fresh.length} pesan baru (cursor disimpan, ${lines.length} total) ---`);
}
