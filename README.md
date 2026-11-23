# Muse Relay — 2 Muse Ngobrol & Kerja Bareng lewat WhatsApp

Relay bot WhatsApp untuk 2 Muse (Suneo + Muse kedua) supaya bisa saling
ngobrol dan bagi tugas lewat chat WhatsApp, dipantau lewat Space monitor.

```
Muse A (Suneo) --tulis--> outbox-a.jsonl --relay bot (Baileys)--> nomor WA B
Muse B           --tulis--> outbox-b.jsonl --relay bot (Baileys)--> nomor WA A
Pesan masuk --> inbox-a / inbox-b.jsonl --> dibaca Muse-nya
```

Muse TIDAK PERNAH menyentuh WhatsApp langsung — relay bot yang memegang
kedua sesi WhatsApp. Obrolan tersimpan sebagai file, jadi aman walau WA
bermasalah.

## Siapa siapa

| | Akun Muse | Nomor WA |
|---|---|---|
| **Muse A** | **Suneo (akun ini)** | **nomor utama Ivan** — DIPUTUSKAN Ivan 23 Nov 10:46 (dia sadar risiko ban, lihat §2) |
| **Muse B** | **garasigerobak@gmail.com** | **nomor kedua Ivan** |

## ⚠️ PERINGATAN — BACA DULU SEBELUM APA PUN

### 1. Baileys = klien WhatsApp TIDAK RESMI — nomor bisa kena BANNED
Bot ini pakai Baileys (library WhatsApp pihak ketiga, bukan WhatsApp resmi).
WhatsApp bisa mendeteksi dan **mem-ban nomor** yang dipakai bot.
**JANGAN PERNAH hubungkan nomor UTAMA Ivan ke Baileys.** Nomor utama adalah
jalur Ivan ngobrol dengan Suneo — kalau nomor itu kena ban, Ivan
**kehilangan akses WhatsApp ke Suneo**.

### 2. Nomor Muse A — DIPUTUSKAN Ivan 23 Nov 10:46
Muse A = **nomor utama Ivan** (nomor WA yang dipakai Ivan ngobrol dengan
Suneo sekarang). Ivan memutuskan ini sendiri setelah membaca peringatan §1 —
dia tahu nomor utama berisiko kena ban karena Baileys, dan tetap memilihnya.
Keputusan ini dicatat apa adanya; Suneo tidak menyarankan ulang, tapi risikonya
tetap berlaku: kalau nomor utama kena ban, Ivan kehilangan akses WhatsApp ke
Suneo. Muse B = **nomor kedua Ivan**.

### 3. Nomor kedua (Muse B) BELUM AKTIF di WhatsApp
Nomor kedua Ivan saat ini **belum terhubung ke WhatsApp sama sekali** dan
Ivan kesulitan mengoneksikannya. Urutan yang benar:
1. Install **WhatsApp Business** di HP (boleh berdampingan dengan WhatsApp
   biasa yang pakai nomor utama).
2. Daftarkan **nomor kedua** di WhatsApp Business.
3. Verifikasi nomor. **PERHATIAN: SMS verifikasi ke nomor ini TERBUKTI
   tidak pernah sampai** (sudah terbukti di kasus login X dan login Kaggle
   — SMS ke nomor kedua tidak pernah datang). **Pakai opsi verifikasi via
   PANGGILAN SUARA ("Call me" / "Hubungi saya")** sebagai fallback —
   pilih itu di layar verifikasi, jawab panggilan, masukkan kode yang
   disebutkan.
4. **HANYA SETELAH nomor aktif di WhatsApp**, relay (Baileys) bisa
   pairing sebagai linked device (scan QR). QR pairing TIDAK BISA dilakukan
   sebelum nomornya aktif — tidak ada jalan pintas.

## Host: VPS Ivan (BUKAN VM Suneo)

Relay **HARUS jalan di VPS Ivan** — VM Suneo restart tiap 1–2 jam, jadi
relay di sana akan mati terus. VPS Ivan stabil, itu alasan host-nya di sana.

- Host: `ubuntu@43.128.95.190` (alias Termius: `vps-guselpe`)
- **Suneo TIDAK BISA SSH langsung ke VPS** — semua langkah di bawah adalah
  langkah **copy-paste manual oleh Ivan di Termius**. Perintah-perintahnya
  sudah disiapkan tinggal tempel.

## Isi paket

```
muse-relay/
├── package.json          # dependensi (Baileys + qrcode-terminal)
├── relay.js              # bot utama (dry-run / live, 2 sesi Baileys)
├── muse-send.js          # helper: Muse tulis pesan ke outbox
├── muse-read.js          # helper: Muse baca pesan baru di inbox
├── space-sync.js         # sync opsional relay -> Space monitor
├── watchdog.sh           # cek bot tiap 5 menit, restart kalau mati
├── muse-relay.service    # contoh systemd unit (opsional, alternatif cron)
├── cron.example          # contoh cron watchdog
├── protocol.md           # spesifikasi format file outbox/inbox
├── config.example.json   # template config (PLACEHOLDER — isi dulu)
├── test/simulate.js      # tes simulasi tanpa nomor asli
└── README.md             # file ini
```

File runtime (dibuat otomatis saat jalan, jangan di-commit):
`data/*.jsonl`, `data/*.log`, `data/*.json`, `auth/a/`, `auth/b/` (sesi WA).
File mode grup: `data/group.jsonl` (transkrip pesan keluar ke grup),
`data/group-incoming.jsonl` (injeksi pesan grup masuk, dry-run saja).

## Install di VPS (copy-paste di Termius)

### Langkah 0 — kirim kode ke VPS
Pilih salah satu:
- **(a) Lewat file ZIP (paling gampang):** download `muse-relay-v1.0.0.zip`,
  upload ke VPS lewat SFTP di Termius (drag file ke `/home/ubuntu/`),
  lalu di terminal VPS:
  ```bash
  cd /home/ubuntu && unzip -o muse-relay-v1.0.0.zip && cd muse-relay && ls
  ```
- **(b) Lewat GitHub (kalau repo sudah dibuat):**
  ```bash
  cd /home/ubuntu && git clone <URL-REPO> muse-relay && cd muse-relay
  ```

### Langkah 1 — Node.js 20+ (cek dulu)
```bash
node --version
```
Kalau belum ada atau di bawah v20, install Node 22 LTS:
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

### Langkah 2 — install dependensi
```bash
cd /home/ubuntu/muse-relay
npm install
```
(Butuh internet di VPS. Kalau `npm install` lama, tunggu — Baileys + deps.)

### Langkah 3 — isi config (NOMOR MASIH PLACEHOLDER — isi dulu)
```bash
cp config.example.json config.json
nano config.json
```
Isi:
- `museA.number` — nomor WA Muse A (format `+62...`, lihat peringatan di atas)
- `museB.number` — nomor kedua Ivan (format `+62...`)
- `mode` — biarkan `"dry-run"` dulu untuk tes (langkah 4). Ganti ke `"live"`
  hanya setelah kedua nomor AKTIF di WhatsApp + pairing QR selesai.
- `space.ingestUrl` — kosongkan dulu (diisi belakangan kalau mau sync ke Space).

Simpan: `Ctrl+O`, `Enter`, `Ctrl+X`.

### Langkah 4 — tes tanpa nomor asli (dry-run)
```bash
npm test
```
Harus keluar `SEMUA TES LOLOS` (26 tes: relay start, 2 pesan A→B + 2 pesan
B→A sampai di inbox yang benar, mode grup — perintah owner ke kedua inbox,
outbox ke grup + DM, pesan non-owner diabaikan, dedup, anti-gema —,
watchdog restart bot yang di-kill, heartbeat).
Kalau ada yang FAIL, jangan lanjut — kirim outputnya ke Suneo.

Tes manual:
```bash
node relay.js --mode dry-run &
node muse-send.js A "Halo B, tes dari Suneo"
sleep 4
node muse-read.js B
# harus tampil: [waktu] A -> B: Halo B, tes dari Suneo
```

### Langkah 5 — pairing live (HANYA SETELAH kedua nomor aktif di WhatsApp)
Pilih salah satu cara pairing:

**(a) QR (default):**
```bash
node relay.js --mode live
```
- QR pertama muncul di terminal → scan dengan WhatsApp **nomor A** (Linked devices / Perangkat tertaut > Tautkan perangkat).
- QR kedua muncul → scan dengan WhatsApp **nomor B**.
- Kalau muncul `connection open` untuk A dan B, pairing sukses. Sesi tersimpan
  di `auth/a/` dan `auth/b/` — jangan hapus folder itu (kalau dihapus, harus
  pairing ulang).
- Berhentikan bot: `Ctrl+C`.

**(b) Kode pairing — tanpa kamera (kalau cuma ada 1 HP):**
QR tidak bisa di-scan kalau QR-nya tampil di layar HP yang sama dengan
WhatsApp-nya (kamera HP tidak bisa memotret layarnya sendiri). Pakai kode
pairing sebagai gantinya:
```bash
node relay.js --mode live --pairing-code
```
- **SEQUENTIAL (v3): pairing satu nomor dulu sampai terhubung, baru
  nomor berikutnya.** Relay menghubungkan nomor A dulu; kode B BARU
  muncul setelah A terhubung (`connection open` untuk A). Jadi dalam
  satu waktu cuma SATU kode yang tampil — tidak ada lagi dua kode
  bersamaan yang gampang ketuker. Kalau satu nomor belum terhubung
  dalam 3 menit, relay lanjut otomatis ke nomor berikutnya (tidak
  macet).
- Relay mencetak **kode pairing 8 karakter** per nomor di terminal.
  Kode diminta saat socket masuk state pairing, lalu **di-refresh otomatis
  tiap 40 dtk** sampai sisi itu terhubung — jadi selalu ada kode segar.
  **SELALU pakai kode TERBARU yang tercetak** (label "KODE PAIRING
  TERBARU"); kode lama cepat kedaluwarsa (~1 menit), jangan pakai kode
  dari pesan/chat lama.
- Masukkan kode itu di WhatsApp nomor tersebut: **Perangkat tertaut >
  Tautkan perangkat > "Tautkan dengan nomor telepon"** (tanpa scan QR).
  Kode pertama untuk nomor A (WhatsApp BIASA, nomor utama), kode kedua
  untuk nomor B (WhatsApp BUSINESS, nomor kedua). Jangan ketuker:
  **tunggu A muncul `connection open` dulu, baru masukkan kode B.**
- Kalau muncul `connection open` untuk A dan B, pairing sukses (sesi
  tersimpan di `auth/a/` dan `auth/b/` seperti cara QR).
- Berhentikan bot: `Ctrl+C`.
- Kalau minta kode gagal, jalankan lagi tanpa `--pairing-code` (fallback QR).

### Langkah 6 — jalankan sebagai service (biar hidup terus)
Pilih salah satu:
- **(a) systemd (disarankan):**
  ```bash
  sudo cp muse-relay.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now muse-relay
  sudo systemctl status muse-relay
  ```
- **(b) nohup + watchdog cron:**
  ```bash
  nohup node relay.js >> data/relay.log 2>&1 &
  crontab -e
  # tempel baris ini:
  */5 * * * * /home/ubuntu/muse-relay/watchdog.sh >> /home/ubuntu/muse-relay/data/watchdog.log 2>&1
  ```

### Langkah 7 — cek bot hidup
```bash
tail -20 data/relay.log
cat data/heartbeat.json
```
`heartbeat.json` ter-update tiap 1 menit saat relay jalan.

## Cara pakai (setelah live)

Dari sisi masing-masing Muse (atau dari terminal VPS untuk tes):
```bash
# Muse A kirim pesan ke B:
node muse-send.js A "Riset token X selesai, ringkasannya..."
# Muse B baca pesan masuk:
node muse-read.js B
# Muse B balas:
node muse-send.js B "Sip, gue eksekusi bagian listing-nya."
# Muse A baca balasan:
node muse-read.js A
```

## Mode grup — Ivan kontrol 2 Muse dari 1 grup WA

Ivan bisa ngasih perintah ke **kedua Muse sekaligus** dari satu grup
WhatsApp, dan balasan kedua Muse muncul di grup itu juga.

```
Grup WA (nomor A + nomor B)
  Ivan ketik perintah di grup
    -> relay tulis ke inbox A DAN inbox B (from: "owner")
  Muse A balas via outbox-a
    -> relay kirim ke DM B (seperti biasa) DAN ke grup
  Muse B balas via outbox-b
    -> relay kirim ke DM A (seperti biasa) DAN ke grup
```

### Setup grup (langkah Ivan, di HP)

1. **Buat grup WhatsApp** berisi kedua nomor: nomor utama Ivan + nomor
   kedua. Nama grup bebas, mis. "Muse A + Muse B".
2. **Tidak perlu isi JID manual** — relay di live mode otomatis mencari
   grup pertama yang berisi kedua nomor (auto-detect, dicek tiap 1 menit).
   JID grup yang ketemu dicatat di `data/relay.log` dan
   `data/heartbeat.json` (`group.groupJid`).
3. Kalau mau dikunci ke grup tertentu (mis. ada lebih dari satu grup berisi
   kedua nomor), isi `group.groupJid` di `config.json` dengan JID dari log,
   lalu restart relay. JID grup bentuknya seperti
   `1203630xxxxxxxxx@g.us`.
4. **Restart relay** setelah grup dibuat/diubah (systemd: `sudo systemctl
   restart muse-relay`, atau matikan + jalankan ulang).

### Cara pakai mode grup

- Ivan ketik perintah di grup seperti biasa — kedua Muse membacanya lewat
  `muse-read.js` (tampil sebagai `owner -> A:` / `owner -> B:`).
- Pesan di grup dari **peserta selain owner diabaikan** — cuma nomor utama
  Ivan yang dianggap perintah.
- Balasan Muse tetap terkirim via DM lawan seperti biasa; salinan grupnya
  cuma tambahan (kalau pengiriman grup gagal, DM tetap jalan).
- **Matikan mode grup:** isi `"enabled": false` di `group` di `config.json`,
  lalu restart relay. DM A↔B tetap jalan normal.
- Detail protokol lengkap: `protocol.md` bagian "Mode grup".

## Space monitor

Space **"Muse Relay Monitor"** menampilkan percakapan A↔B + status tiap Muse
(siapa yang belum balas + sejak kapan) + status hidup/mati relay.
- Data contoh sudah ter-seed di Space saat dibuat.
- **Sync live (opsional):** isi `space.ingestUrl` di `config.json` dengan URL
  action ingest Space, lalu restart relay. Relay akan mem-push setiap pesan
  + heartbeat ke Space. Kalau URL kosong, sync nonaktif dan Space hanya
  menampilkan data yang di-ingest manual — relay tetap jalan normal.

## Troubleshooting

| Gejala | Penyebab / solusi |
|---|---|
| `npm install` gagal network | Cek internet VPS (`curl -I https://registry.npmjs.org`). Ulangi. |
| Relay start lalu langsung mati | Cek `data/relay.log` baris terakhir. Pastikan `config.json` ada dan valid JSON (`node -e "console.log(require('./config.json'))"`). |
| QR tidak muncul di mode live | Pastikan mode `live` dan Baileys terinstal (`npm install` sudah jalan). QR muncul sekali per nomor. |
| `connection close` code 401 | Sesi logout — hapus `auth/a` atau `auth/b` yang bersangkutan, pairing ulang. |
| Pesan tidak sampai ke inbox lawan | Cek `data/relay.log` + `data/failed.jsonl`. Di dry-run, pastikan relay jalan (`cat data/relay.pid`, `ps -p $(cat data/relay.pid)`). |
| Watchdog tidak restart bot | Pastikan cron aktif (`crontab -l`), path di `watchdog.sh` benar, `chmod +x watchdog.sh`. |
| SMS verifikasi nomor kedua tidak sampai | SUDAH TERBUKTI tidak pernah sampai (kasus X + Kaggle). Pakai verifikasi **panggilan suara ("Call me")**. |
| Nomor kena ban | Hentikan relay segera. Jangan pairing ulang nomor yang sama berkali-kali. Pakai nomor lain. |

## Batasan & yang masih butuh Ivan

- [x] **Keputusan nomor Muse A** — DIPUTUSKAN 23 Nov 10:46: nomor utama Ivan (Ivan sadar risiko ban).
- [ ] **Aktivasi nomor kedua di WhatsApp Business** (verifikasi via panggilan suara).
- [ ] **2 akun Muse** (A = Suneo akun ini, B = garasigerobak@gmail.com) — Muse B
  perlu akses ke folder ini / config yang sama di VPS (atau jalankan
  `muse-send.js` / `muse-read.js` dari terminal VPS).
- [ ] **Install + pairing di VPS** (langkah copy-paste di atas, via Termius).
- [ ] **Mode grup (opsional, disetujui Ivan 23 Nov 11:19):** buat grup WA
  berisi kedua nomor di HP, relay auto-detect JID-nya (atau isi manual
  `group.groupJid`). Matikan kapan saja via `group.enabled: false`.
- [ ] **(Opsional) isi `space.ingestUrl`** kalau mau Space monitor sync live.

## Keamanan

- Baileys = klien tidak resmi; risiko ban nomor selalu ada. Jangan pakai nomor utama.
- Jangan commit `config.json` berisi nomor asli ke repo publik.
- Jangan bagikan folder `auth/` (berisi kredensial sesi WhatsApp).
- Jangan pernah kirim seed phrase / private key lewat relay (atau lewat WA mana pun).
