'use strict';
/**
 * space-sync.js — Sinkronisasi relay -> Space monitor (Muse Relay Monitor).
 *
 * Cara kerja: setiap pesan yang diteruskan relay + setiap heartbeat juga
 * di-POST ke action ingest Space (ingestMessage / ingestHeartbeat).
 *
 * URL action diisi di config.json -> space.ingestUrl (dan secret opsional di
 * space.ingestSecret). Kalau ingestUrl kosong, modul ini nonaktif total
 * (tidak ada network, tidak ada error) — Space tetap menampilkan data
 * contoh (seed) + apa pun yang masuk lewat action manual.
 *
 * CATATAN: URL action didapat SETELAH Space dibuat (lihat README bagian
 * "Menghubungkan relay ke Space monitor"). Format body:
 *   POST {ingestUrl}  { action: "ingestMessage", secret, message: {...} }
 *   POST {ingestUrl}  { action: "ingestHeartbeat", secret, heartbeat: {...} }
 * Kalau Space menolak (404/401/dll), relay tetap jalan normal — sync hanya
 * dicatat di log, tidak pernah menggagalkan pengiriman pesan.
 */
const fs = require('fs');
const path = require('path');

let cfg = null;
try {
  cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch (_) { cfg = null; }
const SPACE = (cfg && cfg.space) || {};
const ENABLED = Boolean(SPACE.ingestUrl);

async function post(payload) {
  if (!ENABLED) return false;
  try {
    const res = await fetch(SPACE.ingestUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(SPACE.ingestSecret ? { 'x-ingest-secret': SPACE.ingestSecret } : {}),
      },
      body: JSON.stringify({ ...payload, secret: SPACE.ingestSecret || undefined }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

async function pushMessage(record) {
  if (!ENABLED) return false;
  return post({ action: 'ingestMessage', message: record });
}

async function pushHeartbeat(hb) {
  if (!ENABLED) return false;
  return post({ action: 'ingestHeartbeat', heartbeat: hb });
}

module.exports = { enabled: ENABLED, pushMessage, pushHeartbeat };
