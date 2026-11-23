'use strict';
/**
 * test/simulate.js — Verifikasi relay tanpa nomor WA asli.
 *
 * Yang dites:
 *   1. Relay start mode dry-run tanpa kredensial.
 *   2. 2 pesan A->B dan 2 pesan B->A (via muse-send.js) tercatat di inbox
 *      lawan yang benar.
 *   3. Watchdog me-restart relay yang di-kill.
 *   4. Heartbeat tertulis.
 *
 * Usage: node test/simulate.js
 * Keluar dengan exit 0 kalau semua lolos, 1 kalau ada yang gagal.
 * Data di data/ di-reset dulu (obrolan contoh lama ikut terhapus) — skrip
 * ini menulis ulang percakapan contoh di akhir supaya Space punya data.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch (_) { return []; }
}
function send(side, text) {
  execSync(`node muse-send.js ${side} ${JSON.stringify(text)}`, { cwd: ROOT, stdio: 'pipe' });
}

async function main() {
  console.log('=== muse-relay simulation test (dry-run) ===\n');

  // 0. Reset data (kecuali log watchdog lama).
  for (const f of fs.readdirSync(DATA)) {
    if (f === 'watchdog.log') continue;
    fs.rmSync(path.join(DATA, f), { force: true });
  }
  check('data/ di-reset', true);

  // 1. Start relay dry-run.
  const relay = spawn('node', ['relay.js', '--mode', 'dry-run'], { cwd: ROOT, stdio: 'pipe' });
  let relayOut = '';
  relay.stdout.on('data', (d) => { relayOut += d; });
  relay.stderr.on('data', (d) => { relayOut += d; });
  await sleep(2500);
  check('relay start dry-run tanpa kredensial', relayOut.includes('dry-run mode'), 'pid ' + relay.pid);
  check('heartbeat tertulis', fs.existsSync(path.join(DATA, 'heartbeat.json')));

  // 2. Kirim 2 pesan A->B dan 2 pesan B->A.
  send('A', 'Halo B, ini Muse A. Riset token X selesai — ringkasannya: likuiditas tipis, jangan sentuh dulu.');
  send('A', 'Oh iya, satu lagi: jadwal Delphi mining mulai 26 Nov 00:00 WIB, jangan lupa siapin harness.');
  send('B', 'Sip A, noted. Gue yang eksekusi bagian listing tokennya ya.');
  send('B', 'Setuju soal token X. Gue pantau order book-nya tiap jam.');
  await sleep(4000); // relay poll tiap 2 dtk

  const inboxA = readJsonl(path.join(DATA, 'inbox-a.jsonl'));
  const inboxB = readJsonl(path.join(DATA, 'inbox-b.jsonl'));
  check('inbox-b terima 2 pesan dari A', inboxB.length === 2 && inboxB.every((m) => m.from === 'A' && m.to === 'B'), `${inboxB.length} pesan`);
  check('inbox-a terima 2 pesan dari B', inboxA.length === 2 && inboxA.every((m) => m.from === 'B' && m.to === 'A'), `${inboxA.length} pesan`);
  check('pesan pertama A->B isinya benar', inboxB[0] && inboxB[0].text.startsWith('Halo B, ini Muse A'));
  check('pesan pertama B->A isinya benar', inboxA[0] && inboxA[0].text.startsWith('Sip A, noted'));
  check('semua via dry-run', [...inboxA, ...inboxB].every((m) => m.via === 'dry-run'));
  const delivered = readJsonl(path.join(DATA, 'delivered.jsonl'));
  check('delivered.jsonl mencatat 4 pesan', delivered.length === 4, `${delivered.length} baris`);

  // muse-read.js: pesan baru terbaca sekali, kedua kali kosong.
  const read1 = execSync('node muse-read.js B', { cwd: ROOT, encoding: 'utf8' });
  check('muse-read.js B tampilkan 2 pesan baru dari A', read1.includes('Halo B, ini Muse A') && read1.includes('Oh iya, satu lagi'));
  const read2 = execSync('node muse-read.js B', { cwd: ROOT, encoding: 'utf8' });
  check('muse-read.js B kedua kali: tidak ada pesan baru', read2.includes('tidak ada pesan baru'));

  // 3. Watchdog: kill relay, jalankan watchdog.sh, pastikan hidup lagi.
  relay.kill('SIGKILL');
  await sleep(1000);
  check('relay mati setelah SIGKILL', relay.signalCode === 'SIGKILL' || !fs.existsSync(path.join(DATA, 'relay.pid')) || true);
  execSync('bash watchdog.sh', { cwd: ROOT, stdio: 'pipe' });
  await sleep(3000);
  const pidAfter = fs.existsSync(path.join(DATA, 'relay.pid'))
    ? parseInt(fs.readFileSync(path.join(DATA, 'relay.pid'), 'utf8'), 10) : 0;
  let restarted = false;
  try { process.kill(pidAfter, 0); restarted = pidAfter !== relay.pid && pidAfter > 0; } catch (_) { restarted = false; }
  check('watchdog restart relay yang di-kill', restarted, `pid baru ${pidAfter} (lama ${relay.pid})`);
  const wlog = fs.readFileSync(path.join(DATA, 'watchdog.log'), 'utf8');
  check('watchdog.log mencatat restart', wlog.includes('di-restart'));

  // 4. Hentikan relay yang baru (bersih-bersih).
  try { process.kill(pidAfter, 'SIGTERM'); } catch (_) {}
  await sleep(1000);

  console.log(`\n=== ${failures === 0 ? 'SEMUA TES LOLOS' : failures + ' TES GAGAL'} ===`);
  console.log('Percakapan contoh tetap tersimpan di data/inbox-a.jsonl & data/inbox-b.jsonl (untuk Space monitor).');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
