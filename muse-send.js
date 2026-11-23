'use strict';
/**
 * muse-send.js — Muse menulis pesan ke outbox-nya sendiri.
 *
 * Usage:
 *   node muse-send.js A "Halo B, ini Muse A"
 *   node muse-send.js B "Halo A, ini Muse B"
 *   node muse-send.js A --file ./pesan.txt     (baca teks dari file)
 *   node muse-send.js A --config ./config.json "teks..."
 *
 * Pesan ditulis sebagai satu baris JSONL ke outbox sisi pengirim:
 *   {"id":"A-1795400000000-x7k2","from":"A","to":"B","text":"...","ts":1795400000000}
 * Relay bot yang meneruskannya ke nomor lawan (lihat relay.js).
 * JANGAN menulis langsung ke outbox lawan atau ke inbox — itu tugas relay.
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
  console.error('Usage: node muse-send.js <A|B> "<teks>" [--file <path>] [--config <path>]');
  process.exit(1);
}
const configPath = path.resolve(flagValue(argv, '--config') || './config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const other = side === 'A' ? 'B' : 'A';
const cfg = side === 'A' ? config.museA : config.museB;

let text = argv[1] || '';
const fileArg = flagValue(argv, '--file');
if (fileArg) text = fs.readFileSync(path.resolve(fileArg), 'utf8').trim();
if (!text) {
  console.error('Teks pesan kosong. Beri teks sebagai argumen atau --file <path>.');
  process.exit(1);
}

const id = `${side}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const msg = { id, from: side, to: other, text, ts: Date.now() };
const outbox = path.isAbsolute(cfg.outbox) ? cfg.outbox : path.join(path.dirname(configPath), cfg.outbox);
fs.mkdirSync(path.dirname(outbox), { recursive: true });
fs.appendFileSync(outbox, JSON.stringify(msg) + '\n');
console.log(`terkirim ke outbox-${side.toLowerCase()} (id ${id}) — relay akan meneruskan ke ${other}`);
console.log(JSON.stringify(msg));
