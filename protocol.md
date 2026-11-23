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
| `data/.muse-b-state.json` | Mikasa (muse-b.js) | Mikasa | cursor byte inbox-b + id pesan yang sudah dibalas (dedup restart-safe) |
| `data/muse-b.log` | Mikasa (muse-b.js) | operator | log teks worker Mikasa |
| `data/muse-b.pid` | Mikasa (muse-b.js) | operator | PID proses Mikasa yang sedang jalan |
| `data/heartbeat.json` | relay (tiap 1 mnt) | Space monitor | status hidup relay + aktivitas terakhir |
| `data/relay.log` | relay + watchdog | operator | log teks semua kejadian |
| `data/relay.pid` | relay | watchdog | PID proses relay yang sedang jalan |
| `data/group.jsonl` | relay | operator / tes | transkrip pesan outbox yang diteruskan ke grup |
| `data/group-incoming.jsonl` | operator / tes (dry-run saja) | relay | injeksi pesan grup masuk (simulasi WA grup) |
| `data/.group-cursor.json` | relay | relay | offset byte group-incoming.jsonl yang sudah dibaca |

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

## Mode grup — Ivan perintah kedua Muse dari satu grup WA

Grup WhatsApp berisi **kedua nomor** (A + B). Relay memantau grup itu:

| Arah | Perilaku |
|---|---|
| Owner kirim pesan di grup | Relay tulis ke inbox **A dan B** (`from: "owner"`, `via: "whatsapp-group"` / `"dry-run-group"`, `group: true`). Kedua Muse membacanya lewat `muse-read.js` seperti pesan biasa. |
| Muse A/B kirim via outbox | Relay kirim ke **DM lawan (seperti biasa) DAN ke grup** (sebagai nomor Muse itu). Grup bersifat tambahan, bukan pengganti DM. |
| Peserta grup BUKAN owner kirim pesan | Diabaikan (dicatat di log saja). |
| Pesan relay sendiri di grup | Diabaikan (anti-gema): relay tidak memproses ulang pesannya sendiri yang kembali lewat sesi Baileys lawan — dideteksi dari ID pesan WA yang dikirim + cache teks 15 detik. |

Config (`config.json` → `group`):

```json
"group": {
  "enabled": true,
  "groupJid": "",
  "ownerNumber": ""
}
```

| Field | Arti |
|---|---|
| `enabled` | `false` = mode grup mati total (hanya DM A↔B). Default `true`. |
| `groupJid` | JID grup, mis. `"1203630xxxxxxxxx@g.us"`. Kosong (`""`) = **auto-detect** di live mode: relay mencari grup pertama yang berisi nomor A DAN B (dicek tiap 1 menit sampai ketemu, JID-nya dicatat di `data/relay.log` + `data/heartbeat.json`). Di dry-run dipakai grup virtual `"group-dry-run@g.us"`. |
| `ownerNumber` | Nomor WA owner (Ivan). Kosong (`""`) = nomor Muse A. Hanya pesan dari nomor ini yang diteruskan sebagai perintah owner. |

Format perintah owner di inbox (sama untuk A dan B, beda field `to`):

```json
{"id": "wa-...", "from": "owner", "to": "A", "text": "Kerjakan riset X, bagi tugas", "ts": 1795400000000, "receivedAt": 1795400001000, "receivedAtIso": "2026-11-23T03:00:01.000Z", "via": "whatsapp-group", "group": true, "groupJid": "1203630xxxxxxxxx@g.us"}
```

Transkrip pesan keluar ke grup (`data/group.jsonl`):

```json
{"id": "A-1795400000000-x7k2", "from": "A", "to": "group", "text": "...", "ts": 1795400000000, "groupJid": "1203630xxxxxxxxx@g.us", "via": "whatsapp-group"}
```

### Injeksi pesan grup (dry-run saja, untuk tes)

Di dry-run, pesan grup masuk disimulasikan lewat file
`data/group-incoming.jsonl` (satu baris JSON per pesan):

```json
{"id": "g-1", "senderJid": "62812...@s.whatsapp.net", "text": "Kerjakan riset X", "ts": 1795400000000}
```

- `senderJid` = JID pengirim (owner = JID nomor utama Ivan; bukan owner = diabaikan).
- `remoteJid` opsional (default = grup yang aktif). Di live mode file ini
  diabaikan — sumber pesan grup adalah event Baileys.
- Dedup by `id`: pesan dengan id yang sama tidak diproses 2x (juga
  berlaku antar kedua sesi Baileys di live mode — pesan owner yang sama
  terlihat di kedua sesi).

### Catatan live mode

- Pesan owner dari nomor A terlihat sebagai **fromMe di sesi A** tapi
  sebagai pesan biasa di sesi B — relay menangani pesan grup SEBELUM
  skip `fromMe`, jadi perintah owner tetap masuk lewat sesi B.
- Gagal kirim ke grup (mis. bot dikeluarkan dari grup) TIDAK menggagalkan
  pengiriman DM — dicatat sebagai warning di log, DM tetap jalan.
- Kalau relay belum menemukan grup (auto-detect belum ketemu), pesan
  outbox tetap terkirim via DM; pengiriman grup dimulai begitu JID ketemu.

## Mikasa (Agent B) — worker balasan

`muse-b.js` adalah worker Mikasa (Agent B): ia mem-poll `data/inbox-b.jsonl`
(cursor byte di `data/.muse-b-state.json`, pola sama seperti `pollOutbox`
relay) dan membalas tiap pesan baru dari `"owner"` atau `"A"` dengan menulis
ke `data/outbox-b.jsonl` (`{id: "B-<ts>-<rand>", from: "B", to: "A", text, ts}`).
Relay yang meneruskan balasan ke DM A + grup.

- **Dibalas:** sapaan (balasan sapaan + tanya tugas), perintah/tugas (balasan
  rencana singkat), obrolan biasa (akui isi + tawarkan lanjut).
- **Diabaikan:** `from: "B"` (pesan sendiri, anti-loop), `from:
  "status@broadcast"`, `via: "dry-run"` / `"dry-run-group"` (simulasi).
- **Dedup:** id yang sudah dibalas disimpan di state file (maks 500 id
  terakhir), jadi restart tidak bikin balasan ganda.
- **v1 = template kontekstual (BUKAN LLM):** tanpa internet/API/tools.
  Jangan klaim Mikasa mengerjakan sesuatu yang tidak bisa dibuktikan.
- **Flag:** `--once` (proses sekali lalu keluar), `--dry-run` (baca saja,
  jangan tulis outbox, jangan simpan state), `--config <path>`.
- **Service:** `muse-b.service` (systemd, `Restart=always`). Log:
  `data/muse-b.log`. PID: `data/muse-b.pid`.

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
   "siapa yang belum balas sejak kapan". Heartbeat juga membawa
   `group: {enabled, groupJid, detected}` untuk status mode grup.
6. **Mode grup**: hanya pesan dari nomor owner di grup yang diteruskan
   ke kedua Muse. Pesan grup dari peserta lain diabaikan. Pesan outbox
   Muse dikirim ke grup sebagai tambahan DM — kalau pengiriman grup
   gagal, DM tetap jalan. Matikan mode grup dengan
   `group.enabled: false` di `config.json` + restart relay.
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
