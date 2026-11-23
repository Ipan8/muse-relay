'use strict';
/**
 * test/simulate-bridge.js — Verifikasi Jembatan HTTP tanpa nomor WA asli.
 *
 * Yang dites (server di port ephemeral 0, direktori temp terisolasi,
 * TIDAK menyentuh data/ asli):
 *   1. GET /inbox-b tanpa token -> 401; token salah -> 401.
 *   2. GET /inbox-b token benar, inbox kosong -> {ok:true, messages:[]}.
 *   3. POST /outbox-b tanpa text -> 400; body bukan JSON -> 400.
 *   4. POST /outbox-b dengan text -> 200 {ok:true, id} + baris tertulis
 *      di outbox-b.jsonl (from "B", to "A", id format "B-<ts>-<rand>").
 *   5. POST /outbox-a dengan text -> 200 + baris di outbox-a.jsonl
 *      (from "A", to "B").
 *   6. GET /inbox-b setelah 1 pesan ditulis ke inbox-b -> berisi pesan itu;
 *      GET kedua kalinya -> [] (cursor maju, tiap pesan sekali).
 *   7. GET /inbox-b?all=1 -> berisi pesan itu lagi (baca ulang semua).
 *   8. GET /status -> 200, ada bridge.pid + bridge.port; relay null
 *      (belum ada heartbeat), lalu setelah heartbeat ditulis -> relay ada.
 *   9. GET /tidak-ada -> 404. OPTIONS /inbox-b -> 204 + header CORS.
 *  10. Tanpa token (server dibuat tanpa token) -> semua request 401.
 *
 * Usage: node test/simulate-bridge.js
 * Keluar dengan exit 0 kalau semua lolos, 1 kalau ada yang gagal.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { createServer } = require(path.join(ROOT, 'bridge.js'));

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
async function fetchJson(base, p, opts) {
  const res = await fetch(base + p, opts);
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }
  return { status: res.status, headers: res.headers, body };
}

async function main() {
  console.log('=== Jembatan HTTP (bridge) simulation test ===\n');

  // 0. Direktori temp terisolasi dengan config + data sendiri.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    museA: { inbox: 'data/inbox-a.jsonl', outbox: 'data/outbox-a.jsonl', number: '+6280000000001', name: 'Suneo (Muse A)' },
    museB: { inbox: 'data/inbox-b.jsonl', outbox: 'data/outbox-b.jsonl', number: '+6280000000002', name: 'Mikasa (Agent B)' },
    heartbeatFile: 'data/heartbeat.json',
    pollMs: 200,
  }, null, 2));
  check('direktori tes temp dibuat', fs.existsSync(path.join(tmpDir, 'config.json')));

  const TOKEN = 'test-token-abc-123';
  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
  const server = createServer({ root: tmpDir, config, port: 0, token: TOKEN });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };

  // 1. Auth: tanpa token -> 401; token salah -> 401.
  let r = await fetchJson(base, '/inbox-b', {});
  check('GET /inbox-b tanpa token -> 401', r.status === 401, `status ${r.status}`);
  r = await fetchJson(base, '/inbox-b', { headers: { Authorization: 'Bearer salah' } });
  check('GET /inbox-b token salah -> 401', r.status === 401, `status ${r.status}`);

  // 2. GET /inbox-b token benar, inbox kosong -> [].
  r = await fetchJson(base, '/inbox-b', auth);
  check('GET /inbox-b token benar, inbox kosong -> []', r.status === 200 && r.body && r.body.ok === true && Array.isArray(r.body.messages) && r.body.messages.length === 0, `status ${r.status}, ${JSON.stringify(r.body)}`);
  r = await fetchJson(base, '/inbox-a', auth);
  check('GET /inbox-a token benar, inbox kosong -> []', r.status === 200 && r.body && r.body.messages && r.body.messages.length === 0);

  // 3. POST tanpa text -> 400; body bukan JSON -> 400.
  r = await fetchJson(base, '/outbox-b', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  check('POST /outbox-b tanpa text -> 400', r.status === 400, `status ${r.status}`);
  r = await fetchJson(base, '/outbox-b', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: 'bukan json' });
  check('POST /outbox-b body bukan JSON -> 400', r.status === 400, `status ${r.status}`);

  // 4. POST /outbox-b dengan text -> 200 + baris tertulis.
  r = await fetchJson(base, '/outbox-b', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Halo A, ini Mikasa' }) });
  check('POST /outbox-b dengan text -> 200 + id', r.status === 200 && r.body && r.body.ok === true && typeof r.body.id === 'string', `status ${r.status}, ${JSON.stringify(r.body)}`);
  const outB = readJsonl(path.join(dataDir, 'outbox-b.jsonl'));
  check('outbox-b.jsonl berisi 1 baris from B ke A', outB.length === 1 && outB[0].from === 'B' && outB[0].to === 'A' && outB[0].text === 'Halo A, ini Mikasa', `${outB.length} baris`);
  check('outbox-b id format B-<ts>-<rand>', outB[0] && /^B-\d+-[a-z0-9]{4}$/.test(outB[0].id), outB[0] ? outB[0].id : 'tidak ada');

  // 5. POST /outbox-a dengan text -> 200 + baris di outbox-a.
  r = await fetchJson(base, '/outbox-a', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Halo B, ini Suneo' }) });
  check('POST /outbox-a dengan text -> 200 + id', r.status === 200 && r.body && r.body.ok === true && typeof r.body.id === 'string');
  const outA = readJsonl(path.join(dataDir, 'outbox-a.jsonl'));
  check('outbox-a.jsonl berisi 1 baris from A ke B', outA.length === 1 && outA[0].from === 'A' && outA[0].to === 'B' && outA[0].text === 'Halo B, ini Suneo', `${outA.length} baris`);

  // 6. Tulis 1 pesan ke inbox-b, GET -> berisi pesan; GET lagi -> [] (cursor).
  const now = Date.now();
  fs.appendFileSync(path.join(dataDir, 'inbox-b.jsonl'), JSON.stringify({ id: 't-1', from: 'owner', to: 'B', text: 'Halo Mikasa, kerjakan riset X', ts: now, receivedAt: now, receivedAtIso: new Date(now).toISOString(), via: 'whatsapp-group', group: true }) + '\n');
  r = await fetchJson(base, '/inbox-b', auth);
  check('GET /inbox-b setelah 1 pesan -> berisi pesan itu', r.status === 200 && r.body.messages.length === 1 && r.body.messages[0].id === 't-1' && r.body.messages[0].text.includes('riset X'), `${r.body.messages.length} pesan`);
  r = await fetchJson(base, '/inbox-b', auth);
  check('GET /inbox-b kedua kalinya -> [] (cursor maju)', r.status === 200 && r.body.messages.length === 0, `${r.body.messages.length} pesan`);

  // 7. GET /inbox-b?all=1 -> berisi pesan itu lagi.
  r = await fetchJson(base, '/inbox-b?all=1', auth);
  check('GET /inbox-b?all=1 -> berisi pesan (baca ulang)', r.status === 200 && r.body.messages.length === 1 && r.body.messages[0].id === 't-1', `${r.body.messages.length} pesan`);

  // 8. GET /status: relay null dulu, lalu ada setelah heartbeat ditulis.
  r = await fetchJson(base, '/status', auth);
  check('GET /status -> 200 + bridge.pid/port, relay null (belum ada heartbeat)', r.status === 200 && r.body.ok === true && r.body.bridge && typeof r.body.bridge.pid === 'number' && typeof r.body.bridge.port === 'number' && r.body.relay === null, `status ${r.status}`);
  fs.writeFileSync(path.join(dataDir, 'heartbeat.json'), JSON.stringify({ relay: { pid: 1234, mode: 'live', startedAt: now, lastTick: now, lastTickIso: new Date(now).toISOString() }, A: { name: 'Suneo (Muse A)', lastActivity: now }, B: { name: 'Mikasa (Agent B)', lastActivity: now }, group: { enabled: true, groupJid: '120363000000000000@g.us', detected: true } }, null, 2));
  r = await fetchJson(base, '/status', auth);
  check('GET /status setelah heartbeat -> relay.mode live + group terdeteksi', r.status === 200 && r.body.relay && r.body.relay.mode === 'live' && r.body.group && r.body.group.detected === true && r.body.group.groupJid === '120363000000000000@g.us', `status ${r.status}`);

  // 9. Endpoint tidak dikenal -> 404; OPTIONS -> 204 + CORS.
  r = await fetchJson(base, '/tidak-ada', auth);
  check('GET /tidak-ada -> 404', r.status === 404, `status ${r.status}`);
  const optRes = await fetch(base + '/inbox-b', { method: 'OPTIONS' });
  check('OPTIONS /inbox-b -> 204 + header CORS', optRes.status === 204 && optRes.headers.get('access-control-allow-origin') === '*' && (optRes.headers.get('access-control-allow-headers') || '').includes('Authorization'), `status ${optRes.status}`);

  // 10. Server tanpa token -> semua request 401 (fail-closed).
  const server2 = createServer({ root: tmpDir, config, port: 0, token: '' });
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
  const base2 = `http://127.0.0.1:${server2.address().port}`;
  r = await fetchJson(base2, '/status', { headers: { Authorization: 'Bearer apa-pun' } });
  check('server tanpa token: GET /status token apa pun -> 401', r.status === 401, `status ${r.status}`);
  r = await fetchJson(base2, '/inbox-a', auth);
  check('server tanpa token: GET /inbox-a token benar pun -> 401', r.status === 401, `status ${r.status}`);
  await new Promise((resolve) => server2.close(resolve));

  // Bersih-bersih.
  await new Promise((resolve) => server.close(resolve));
  check('server berhenti (close)', true);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  check('direktori temp dibersihkan', !fs.existsSync(tmpDir));

  console.log(`\n=== ${failures === 0 ? 'SEMUA TES BRIDGE LOLOS' : failures + ' TES BRIDGE GAGAL'} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('TES BRIDGE ERROR:', e); process.exit(1); });
