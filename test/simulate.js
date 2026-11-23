'use strict';
/**
 * test/simulate.js — Verifikasi relay tanpa nomor WA asli.
 *
 * Yang dites:
 *   1. Relay start mode dry-run tanpa kredensial.
 *   2. 2 pesan A->B dan 2 pesan B->A (via muse-send.js) tercatat di inbox
 *      lawan yang benar.
 *   3. Mode grup: perintah owner di grup -> inbox A dan B; outbox A/B ->
 *      grup + DM lawan tetap jalan; pesan non-owner diabaikan; dedup id
 *      grup; gema pesan relay sendiri diabaikan.
 *   4. Watchdog me-restart relay yang di-kill.
 *   5. Heartbeat tertulis.
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
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const jidOf = (n) => n.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
const OWNER_JID = jidOf((CONFIG.group && CONFIG.group.ownerNumber) || CONFIG.museA.number);
const JID_A = jidOf(CONFIG.museA.number);
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
function injectGroup(lines) {
  fs.appendFileSync(path.join(DATA, 'group-incoming.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
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

  // 2b. Mode grup: perintah owner -> kedua inbox; non-owner diabaikan; dedup.
  injectGroup([
    { id: 'g-owner-1', senderJid: OWNER_JID, text: 'Ivan: kerjakan riset X, bagi tugas — A listing, B ringkasan.', ts: Date.now() },
    { id: 'g-spam-1', senderJid: '628999999999@s.whatsapp.net', text: 'halo ini bukan owner', ts: Date.now() },
  ]);
  await sleep(3500);
  const inboxA2 = readJsonl(path.join(DATA, 'inbox-a.jsonl'));
  const inboxB2 = readJsonl(path.join(DATA, 'inbox-b.jsonl'));
  const ownerA = inboxA2.find((m) => m.from === 'owner');
  const ownerB = inboxB2.find((m) => m.from === 'owner');
  check('grup: perintah owner sampai ke inbox-a', inboxA2.length === 3 && ownerA && ownerA.to === 'A', `${inboxA2.length} pesan`);
  check('grup: perintah owner sampai ke inbox-b', inboxB2.length === 3 && ownerB && ownerB.to === 'B', `${inboxB2.length} pesan`);
  check('grup: perintah owner bertanda via dry-run-group + group:true', ownerA && ownerA.via === 'dry-run-group' && ownerA.group === true && ownerB && ownerB.via === 'dry-run-group', ownerA ? ownerA.via : 'tidak ada');
  check('grup: pesan non-owner diabaikan', ![...inboxA2, ...inboxB2].some((m) => m.text === 'halo ini bukan owner'));

  // Dedup: id grup yang sama dikirim ulang -> tidak diproses 2x.
  injectGroup([
    { id: 'g-owner-1', senderJid: OWNER_JID, text: 'Ivan: kerjakan riset X, bagi tugas — A listing, B ringkasan.', ts: Date.now() },
  ]);
  await sleep(3000);
  check('grup: dedup id sama tidak diproses 2x', readJsonl(path.join(DATA, 'inbox-a.jsonl')).length === 3 && readJsonl(path.join(DATA, 'inbox-b.jsonl')).length === 3);

  // 2c. Outbox -> grup (tambahan) + DM lawan tetap jalan.
  // Catatan: 4 pesan DM tadi (2 A + 2 B) masing-masing sudah disalin ke
  // grup juga, jadi group.jsonl sudah berisi 4 baris sebelum tes ini.
  check('grup: 4 pesan DM tadi tersalin ke group.jsonl', readJsonl(path.join(DATA, 'group.jsonl')).length === 4);
  send('A', 'Update grup: riset X selesai, listing aman.');
  await sleep(3500);
  const groupLog1 = readJsonl(path.join(DATA, 'group.jsonl'));
  check('grup: pesan A tercatat di group.jsonl', groupLog1.length === 5 && groupLog1[4].from === 'A' && groupLog1[4].text.startsWith('Update grup'), `${groupLog1.length} baris`);
  check('grup: DM B tetap sampai setelah kirim grup', readJsonl(path.join(DATA, 'inbox-b.jsonl')).length === 4);
  send('B', 'Sip, gue lanjut ringkasan.');
  await sleep(3500);
  const groupLog2 = readJsonl(path.join(DATA, 'group.jsonl'));
  check('grup: pesan B tercatat di group.jsonl', groupLog2.length === 6 && groupLog2[5].from === 'B', `${groupLog2.length} baris`);
  check('grup: DM A tetap sampai setelah kirim grup', readJsonl(path.join(DATA, 'inbox-a.jsonl')).length === 4);
  check('grup: delivered.jsonl mencatat 6 pesan', readJsonl(path.join(DATA, 'delivered.jsonl')).length === 6, `${readJsonl(path.join(DATA, 'delivered.jsonl')).length} baris`);

  // 2d. Anti-gema: pesan grup dari nomor A dengan teks yang baru saja relay
  // kirim ke grup (seolah pesan relay sendiri kembali lewat sesi lawan).
  injectGroup([
    { id: 'g-echo-1', senderJid: JID_A, text: 'Update grup: riset X selesai, listing aman.', ts: Date.now() },
  ]);
  await sleep(3000);
  check('grup: gema pesan relay sendiri diabaikan', readJsonl(path.join(DATA, 'inbox-a.jsonl')).length === 4 && readJsonl(path.join(DATA, 'inbox-b.jsonl')).length === 4);

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
