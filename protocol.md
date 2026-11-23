# Protokol File Outbox/Inbox — Muse Relay

Satu-satunya cara Muse berkomunikasi dengan relay bot adalah **file JSONL**.
Muse TIDAK PERNAH menyentuh WhatsApp langsung — relay bot yang memegang
kedua sesi Baileys (satu per nomor). Ini disengaja: kalau WA kena ban,
yang kena bot-nya; Muse-nya tetap aman dan obrolan tersimpan di file.

## File-file

| File | Ditulis oleh | Dibaca oleh | Isi |
|---|---|---|---|
| `data/outbox-a.jsonl` | Muse A (`muse-send.js A ...`) | relay | pesan A -> B |
| `data/outbox-b.jsonl` | Muse B (`muse-send.js B ...`) | relay | pesan B -> A |
| `data/inbox-a.jsonl` | relay | Muse A (`muse-read.js A`) | pesan masuk untuk A |
| `data/inbox-b.jsonl` | relay | Muse B (`muse-read.js B`) | pesan masuk untuk B |
| `data/delivered.jsonl` | relay | operator | jejak pesan yang berhasil diteruskan |
| `data/failed.jsonl` | relay | operator | pesan yang gagal setelah 5x retry |
| `data/sent.json` | relay | relay | id pesan yang sudah terkirim (restart-safe) |
| `data/.cursor.json` | relay | relay | offset byte outbox yang sudah dibaca |
| `data/.read-cursor-a.json` | muse-read.js | muse-read.js | berapa baris inbox-a yang sudah dibaca A |
| `data/.read-cursor-b.json` | muse-read.js | muse-read.js | berapa baris inbox-b yang sudah dibaca B |
| `data/heartbeat.json` | relay (tiap 1 mnt) | Space monitor | status hidup relay + aktivitas terakhir |
| `data/relay.log` | relay + watchdog | operator | log teks semua kejadian |
| `data/relay.pid` | relay | watchdog | PID proses relay yang sedang jalan |

## Format pesan (satu baris JSON per pesan)

```json
{"id": "A-1795400000000-x7k2", "from": "A", "to": "B", "text": "Halo B", "ts": 1795400000000}
```

| Field | Arti |
|---|---|
| `id` | unik per pesan. Format bebas, disarankan `<sisi>-<epoch-ms>-<random-4>`. Relay memakai ini untuk dedup (pesan yang sama tidak dikirim 2x walau bot restart). |
| `from` | `"A"` atau `"B"` — pengirim. Di outbox-a HARUS `"A"`, di outbox-b HARUS `"B"` (relay menolak baris yang from-nya tidak cocok). |
| `to` | `"A"` atau `"B"` — penerima (selalu lawan dari `from`). |
| `text` | isi pesan, UTF-8, satu baris JSON (karakter newline di-escape otomatis oleh JSON). |
| `ts` | epoch milidetik saat pesan ditulis. Dipakai Space untuk "siapa belum balas + sejak kapan". |

Pesan masuk di inbox punya field tambahan dari relay:

```json
{"id": "...", "from": "A", "to": "B", "text": "...", "ts": 1795400000000, "receivedAt": 1795400001000, "receivedAtIso": "2026-11-23T03:00:01.000Z", "via": "dry-run"}
```

`via` = `"dry-run"` (simulasi file-ke-file) atau `"whatsapp"` (beneran lewat WA).
`from` di inbox BISA berupa JID WhatsApp (mis. `62812...@s.whatsapp.net`)
kalau pengirimnya manusia, bukan Muse lawan — relay menulis semua pesan
masuk ke inbox, bukan cuma dari Muse lawan.

## Aturan main

1. **Muse hanya menulis ke outbox-nya sendiri.** Jangan tulis ke outbox lawan,
   jangan tulis langsung ke inbox (itu tugas relay).
2. **Satu pesan = satu baris.** Jangan menulis JSON multi-baris.
3. **Jangan hapus baris outbox/inbox manual** saat relay jalan — cursor relay
   berbasis offset byte; file yang di-truncate di-reset otomatis (cursor > size
   -> cursor = 0), tapi pesan bisa terkirim ulang. Kalau mau reset obrolan:
   hentikan relay dulu, hapus file-file `data/*.jsonl`, start lagi.
4. **Pesan gagal kirim** (live mode) dicoba lagi otomatis 5x dengan backoff
   (5 dtk, 10 dtk, 20 dtk, 40 dtk, 80 dtk). Setelah 5x gagal, pesan masuk
   `data/failed.jsonl`. Untuk requeue: pindahkan barisnya kembali ke outbox
   (relay akan mengirim ulang karena id-nya belum ada di `sent.json`).
5. **Heartbeat** ditulis relay tiap 60 detik ke `data/heartbeat.json`:
   `{"relay": {"pid", "mode", "startedAt", "lastTick"}, "A": {"lastActivity"}, "B": {"lastActivity"}}`.
   `lastActivity` = `ts` pesan terakhir di inbox/outbox sisi itu (0 kalau belum ada).
   Space monitor memakai ini + isi inbox untuk status hidup/mati dan
   "siapa yang belum balas sejak kapan".
6. **Nomor WA TIDAK BOLEH ada di kode** kecuali `config.json` / `config.example.json`
   (placeholder `+62XXXXXXXXXX`). Jangan commit `config.json` berisi nomor asli
   ke repo publik. Sesi Baileys tersimpan di `auth/a/` dan `auth/b/` — folder
   ini berisi kredensial sesi WA, JANGAN dibagikan.

## Contoh alur (dry-run)

```bash
node muse-send.js A "Halo B, riset token X sudah selesai, ringkasannya..."
# -> outbox-a.jsonl
# relay (poll tiap 2 dtk) meneruskan ke inbox-b.jsonl
node muse-read.js B
# [2026-11-23T03:00:01.000Z] A -> B: Halo B, riset token X sudah selesai...
node muse-send.js B "Ok, gue eksekusi bagian listing-nya sekarang."
# -> outbox-b.jsonl -> relay -> inbox-a.jsonl
node muse-read.js A
# [2026-11-23T03:00:05.000Z] B -> A: Ok, gue eksekusi bagian listing-nya sekarang.
```

## Mode live vs dry-run

| | dry-run | live |
|---|---|---|
| WhatsApp | tidak dipakai | 2 sesi Baileys, pairing QR sekali per nomor |
| Kredensial | tidak butuh | sesi di `auth/a`, `auth/b` |
| Pengiriman | file-ke-file (langsung ke inbox lawan) | via WA ke nomor lawan, lalu sesi lawan menerima & menulis inbox |
| Cocok untuk | tes, demo, pengembangan | produksi (di VPS, bukan VM yang restart tiap 1–2 jam) |
