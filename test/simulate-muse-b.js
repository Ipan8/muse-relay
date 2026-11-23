'use strict';
/**
 * test/simulate-muse-b.js — Verifikasi Mikasa (Agent B) tanpa nomor WA asli.
 *
 * Yang dites (di direktori temp terisolasi, TIDAK menyentuh data/ asli):
 *   1. Worker --once membalas sapaan owner (from "owner").
 *   2. Worker --once membalas perintah owner dengan rencana singkat.
 *   3. Pesan dari B (pesan sendiri) TIDAK dibalas (anti-loop).
 *   4. Pesan via dry-run TIDAK dibalas (simulasi, bukan live).
 *   5. outbox-b berisi tepat 2 balasan: from "B", to "A", teks tidak kosong,
 *      id format "B-<ts>-<rand>", balasan sapaan menyebut Mikasa, balasan
 *      tugas menyebut rencana.
 *   6. Idempotensi: jalankan --once kedua kali -> outbox tetap 2 (dedup by id).
 *   7. --dry-run: inbox baru dibaca tapi outbox tetap kosong.
 *
 * Usage: node test/simulate-muse-b.js
 * Keluar dengan exit 0 kalau semua lolos, 1 kalau ada yang gagal.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch (_) { return []; }
}
function runWorker(tmpDir, extraArgs) {
  execSync(`node muse-b.js --config ${JSON.stringify(path.join(tmpDir, 'config.json'))} ${extraArgs}`, {
    cwd: ROOT, stdio: 'pipe',
  });
}

function main() {
  console.log('=== Mikasa (Agent B) simulation test ===\n');

  // 0. Direktori temp terisolasi dengan config + data sendiri.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-b-test-'));
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    museB: { inbox: 'data/inbox-b.jsonl', outbox: 'data/outbox-b.jsonl', number: '+6280000000000', name: 'Mikasa (Agent B)' },
    pollMs: 200,
  }, null, 2));
  check('direktori tes temp dibuat', fs.existsSync(path.join(tmpDir, 'config.json')));

  // 1. Tulis 4 pesan uji ke inbox-b: sapaan, perintah, pesan B, pesan dry-run.
  const now = Date.now();
  const inbox = path.join(dataDir, 'inbox-b.jsonl');
  const msgs = [
    { id: 't-greet-1', from: 'owner', to: 'B', text: 'Halo Mikasa', ts: now, receivedAt: now, receivedAtIso: new Date(now).toISOString(), via: 'whatsapp-group', group: true, groupJid: '120363000000000000@g.us' },
    { id: 't-task-1', from: 'owner', to: 'B', text: 'Mikasa, kerjakan riset token X, bagi tugas — A listing, B ringkasan.', ts: now + 1, receivedAt: now + 1, receivedAtIso: new Date(now + 1).toISOString(), via: 'whatsapp-group', group: true, groupJid: '120363000000000000@g.us' },
    { id: 't-b-1', from: 'B', to: 'A', text: 'Ini pesan gue sendiri, jangan dibalas.', ts: now + 2, receivedAt: now + 2, receivedAtIso: new Date(now + 2).toISOString(), via: 'whatsapp' },
    { id: 't-dry-1', from: 'owner', to: 'B', text: 'Halo (dry-run, harus diabaikan)', ts: now + 3, receivedAt: now + 3, receivedAtIso: new Date(now + 3).toISOString(), via: 'dry-run' },
  ];
  fs.writeFileSync(inbox, msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');

  // 2. Jalankan worker --once.
  runWorker(tmpDir, '--once');
  const outbox = path.join(dataDir, 'outbox-b.jsonl');
  const replies = readJsonl(outbox);
  check('outbox-b berisi tepat 2 balasan (bukan 3/4)', replies.length === 2, `${replies.length} balasan`);
  check('semua balasan from B ke A', replies.length === 2 && replies.every((m) => m.from === 'B' && m.to === 'A'));
  check('semua balasan teks tidak kosong', replies.length === 2 && replies.every((m) => typeof m.text === 'string' && m.text.trim().length > 0));
  check('semua balasan id format B-<ts>-<rand>', replies.length === 2 && replies.every((m) => /^B-\d+-[a-z0-9]{4}$/.test(m.id)));
  check('balasan sapaan menyebut Mikasa', replies[0] && /mikasa/i.test(replies[0].text), replies[0] ? replies[0].text.slice(0, 80) : 'tidak ada');
  check('balasan tugas menyebut rencana', replies[1] && /rencana/i.test(replies[1].text), replies[1] ? replies[1].text.slice(0, 80) : 'tidak ada');
  check('balasan tugas menyebut isi tugas (token X)', replies[1] && /token x/i.test(replies[1].text));

  // 3. Idempotensi: --once kedua kali -> outbox tetap 2.
  runWorker(tmpDir, '--once');
  check('dedup: --once kedua kali outbox tetap 2', readJsonl(outbox).length === 2, `${readJsonl(outbox).length} balasan`);

  // 4. --dry-run: inbox baru dibaca tapi outbox tetap kosong.
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-b-test-dry-'));
  const dataDir2 = path.join(tmpDir2, 'data');
  fs.mkdirSync(dataDir2, { recursive: true });
  fs.writeFileSync(path.join(tmpDir2, 'config.json'), JSON.stringify({
    museB: { inbox: 'data/inbox-b.jsonl', outbox: 'data/outbox-b.jsonl', number: '+6280000000000', name: 'Mikasa (Agent B)' },
    pollMs: 200,
  }, null, 2));
  fs.writeFileSync(path.join(dataDir2, 'inbox-b.jsonl'), JSON.stringify({
    id: 't-dryrun-1', from: 'owner', to: 'B', text: 'Halo Mikasa, tes dry-run', ts: now,
    receivedAt: now, receivedAtIso: new Date(now).toISOString(), via: 'whatsapp-group', group: true,
  }) + '\n');
  runWorker(tmpDir2, '--once --dry-run');
  check('--dry-run: outbox tetap kosong', !fs.existsSync(path.join(dataDir2, 'outbox-b.jsonl')) || readJsonl(path.join(dataDir2, 'outbox-b.jsonl')).length === 0);

  // 5. Bersih-bersih direktori temp.
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(tmpDir2, { recursive: true, force: true });
  check('direktori temp dibersihkan', !fs.existsSync(tmpDir) && !fs.existsSync(tmpDir2));

  console.log(`\n=== ${failures === 0 ? 'SEMUA TES MIKASA LOLOS' : failures + ' TES MIKASA GAGAL'} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
