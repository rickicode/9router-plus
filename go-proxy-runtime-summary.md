# Go Proxy Runtime Summary

## Tujuan

Tujuan utama proyek ini adalah membuat **Go proxy** menjadi **data-plane** yang lebih ringan dan cepat, sementara **9router** tetap menjadi **control-plane utama**.

Secara prinsip:
- **9router** tetap memegang keputusan routing, usage authority, dan status authority
- **Go proxy** hanya bertindak sebagai eksekutor request/proxy layer
- arah terbaru: **runtime Go proxy harus dikelola langsung oleh backend 9router**, bukan terutama lewat env/startup script

## Sistem Saat Ini

### 1. 9router tetap menjadi control-plane

Saat ini 9router masih memegang:
- routing decision
- internal resolve/report authority
- usage/status authority
- startup/runtime orchestration pada jalur lama

### 2. Go proxy sudah memiliki fondasi data-plane

Go proxy yang sudah dibuat saat ini memiliki:
- endpoint publik dasar:
  - `/v1/chat/completions`
  - `/v1/responses`
  - `/v1/messages`
  - `/health`
- kemampuan memanggil internal resolve ke backend 9router
- kemampuan membaca credential file
- forwarding request non-stream dan stream
- fallback berurutan berdasarkan hasil resolve
- report balik ke 9router

### 3. Build dan install binary sudah tersedia

Saat ini script build/install yang sudah ada:
- `npm run build:go-proxy`
- `npm run verify:go-proxy-bin`
- `npm run install:go-proxy`
- `npm run build` = Go build + web build

Binary Go dipasang ke lokasi:
- `~/.9router/bin/9router-go-proxy`

## Yang Baru Sudah Dibuat

### 1. Checkpoint implementasi Go proxy

Sudah dibuat checkpoint implementasi untuk:
- Go proxy module
- route publik dasar
- resolve/report integration
- fallback flow
- testing dasar

### 2. Redesign runtime-management

Sudah dibuat redesign agar backend 9router mengelola Go proxy secara langsung.

Sudah ada fondasi backend runtime manager berupa:
- helper runtime registry di `src/lib/goProxyRuntime.js`
- route runtime dasar:
  - status
  - start
  - stop
  - restart
  - set-port

### 3. Kontrak CLI-flag-first

Go binary sekarang diarahkan menggunakan parameter CLI sebagai jalur utama runtime config, bukan env sebagai primary contract.

### 4. Coverage test

Sudah ditambahkan test untuk:
- resolve/report
- runtime routes
- rollback behavior
- supervision/bootstrap
- parity checks
- build/install helper behavior

## Arah Baru yang Diminta User

Arah terbaru yang diminta user berbeda dari desain resolve-per-request sebelumnya.

Target baru:
- **9router mengirim semua akun provider yang eligible ke Go secara berkala**
- **Go menyimpan data itu sementara (cache sementara / in-memory)**
- **Go memakai daftar akun eligible itu untuk proxying**
- jika Go mendeteksi akun invalid / exhausted / blocked:
  - Go call API 9router untuk melaporkan status akun tersebut
  - Go berhenti memakai akun itu sementara
  - akun itu baru boleh dipakai lagi setelah 9router mengirim daftar eligible terbaru

## Konsekuensinya

Ini berarti ada pergeseran penting dari desain yang sudah lebih dulu dibuat:

### Desain lama yang sudah ada
- Go meminta resolve ke 9router saat request datang
- 9router memutuskan target secara langsung per request

### Desain baru yang diinginkan
- 9router bertindak seperti publisher/supplier daftar akun eligible
- Go bertindak seperti consumer lokal dari daftar akun eligible itu
- Go tidak perlu resolve penuh per request jika daftar akun valid masih tersedia
- Go tetap tidak menjadi source of truth; 9router tetap authority utama untuk status akun

## Ringkasan Singkat

### Sudah jadi
- fondasi Go proxy
- runtime endpoint dasar
- build/install binary
- checkpoint implementasi
- redesign runtime-management awal

### Belum disesuaikan ke arah terbaru
- mekanisme push/sync **eligible accounts list** dari 9router ke Go
- mekanisme cache eligible accounts di Go
- mekanisme Go melaporkan akun invalid/exhausted/blocked lalu mengeluarkannya sementara dari pool lokal
- penggantian model resolve-per-request menjadi model backend-driven eligible-account sync

## Status Saat Ini

Status kerja saat ini bisa diringkas seperti ini:
- **implementasi dasar Go proxy sudah ada**
- **runtime-management backend dasar sudah mulai dibangun**
- **arah arsitektur terbaru sudah berubah** ke model distribusi akun eligible dari 9router ke Go
- **langkah berikutnya yang paling tepat** adalah menyusun gap analysis dan redesign final berdasarkan model sinkronisasi akun eligible tersebut sebelum implementasi lanjutan
