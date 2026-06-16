# 🚀 Panduan Deploy: Omnichannel SaaS CRM + AI Sales Agent

## Prerequisites

Pastikan Anda memiliki:

- **Node.js** v18+ dan npm
- **Wrangler CLI** v3+ (`npm install -g wrangler`)
- **Cloudflare Account** dengan Workers Paid Plan ($5/bulan)
- **Clerk Account** (clerk.com) — untuk autentikasi & multi-tenancy
- **Go-Wa Server** (github.com/aldinokemal/go-whatsapp-web-multidevice) — server Go eksternal
- **iPaymu Account** (ipaymu.com) — payment gateway Indonesia
- **AI Provider Account** — OpenAI, Groq, OpenRouter, atau provider OpenAI-compatible lainnya

---

## 1. Clone & Install

```bash
git clone https://github.com/ramdandev/crm-cloudflare.git
cd crm-cloudflare
npm install
```

---

## 2. Login ke Cloudflare

```bash
wrangler login
```

Ini akan membuka browser untuk autentikasi akun Cloudflare Anda.

---

## 3. Buat Resources di Cloudflare

### 3.1 Buat D1 Database

```bash
wrangler d1 create crm-database
```

Copy `database_id` yang muncul, lalu update di `wrangler.toml`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "crm-database"
database_id = "YOUR_DATABASE_ID_HERE"
```

### 3.2 Buat KV Namespace

```bash
wrangler kv namespace create KV
```

Copy `id` yang muncul, update di `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "KV"
id = "YOUR_KV_NAMESPACE_ID_HERE"
```

### 3.3 Buat R2 Bucket

```bash
wrangler r2 bucket create crm-storage
```

### 3.4 Buat Queues

```bash
wrangler queues create broadcast-messages
wrangler queues create ai-processing
wrangler queues create appointment-reminders
```

---

## 4. Jalankan Database Migrations

```bash
# Migration CRM core (10 tabel)
wrangler d1 migrations apply crm-database

# Ini akan menjalankan:
# - migrations/0001_initial_schema.sql (CRM core tables)
# - migrations/0002_ai_sales_agent.sql (AI agent tables - 20 tabel)
```

Verifikasi tabel berhasil dibuat:
```bash
wrangler d1 execute crm-database --command "SELECT name FROM sqlite_master WHERE type='table'"
```

---

## 5. Setup Secrets (Environment Variables)

⚠️ **PENTING**: Jangan masukkan secrets di `wrangler.toml`! Gunakan `wrangler secret put`:

```bash
# Clerk Authentication
wrangler secret put CLERK_SECRET_KEY
# Masukkan: sk_live_xxxxx (dari Clerk Dashboard → API Keys)

# Go-Wa WhatsApp Gateway
wrangler secret put GOWA_API_KEY
# Masukkan: API key dari Go-Wa server Anda

# Meta Cloud API (WhatsApp Business)
wrangler secret put META_ACCESS_TOKEN
# Masukkan: Token dari Meta Developer Portal
wrangler secret put META_PHONE_NUMBER_ID
# Masukkan: Phone Number ID dari Meta Business Manager

# iPaymu Payment Gateway
wrangler secret put IPAYMU_API_KEY
# Masukkan: API key dari dashboard iPaymu
wrangler secret put IPAYMU_VA
# Masukkan: Virtual Account iPaymu Anda
wrangler secret put IPAYMU_SECRET
# Masukkan: Secret key untuk webhook signature

# Encryption Key (untuk encrypt API key tenant)
wrangler secret put ENCRYPTION_KEY
# Masukkan: String 32+ karakter random (contoh: openssl rand -hex 32)
```

Update `GOWA_BASE_URL` di `wrangler.toml` ke URL Go-Wa server Anda:
```toml
[vars]
GOWA_BASE_URL = "https://your-gowa-server.com"
```

---

## 6. Deploy ke Cloudflare Workers

```bash
# Deploy production
wrangler deploy

# Atau deploy ke staging/preview
wrangler deploy --env staging
```

Setelah deploy berhasil, Anda akan melihat URL seperti:
```
https://crm-cloudflare.your-subdomain.workers.dev
```

---

## 7. Post-Deploy Configuration

### 7.1 Setup Clerk Organizations

1. Buka [Clerk Dashboard](https://dashboard.clerk.com)
2. Buat Organization untuk setiap tenant/bisnis
3. Set permissions/roles:
   - `org:admin` — Akses penuh
   - `org:contacts:read`, `org:contacts:write` — Kelola kontak
   - `org:broadcast:send` — Kirim broadcast
   - `org:audit:read` — Baca audit log
4. Copy `Organization ID` untuk setiap tenant

### 7.2 Registrasi Tenant di Database

```bash
# Insert tenant pertama
wrangler d1 execute crm-database --command \
  "INSERT INTO tenants (id, clerk_org_id, name, plan_tier, broadcast_quota, rate_limit_per_minute, active) 
   VALUES ('tenant-001', 'org_YOUR_CLERK_ORG_ID', 'Nama Bisnis Anda', 'professional', 1000, 1000, 1)"
```

### 7.3 Setup Go-Wa Gateway

1. Deploy Go-Wa server (Docker recommended):
   ```bash
   docker run -d -p 3000:3000 aldinokemal/go-whatsapp-web-multidevice
   ```
2. Scan QR code untuk login WhatsApp
3. Configure webhook di Go-Wa mengarah ke:
   ```
   POST https://your-worker.workers.dev/webhooks/gowa
   Headers:
     Authorization: Bearer YOUR_GOWA_API_KEY
     X-Tenant-Id: tenant-001
   ```

### 7.4 Setup iPaymu Webhook

1. Login ke [dashboard iPaymu](https://my.ipaymu.com)
2. Set Notification URL ke:
   ```
   https://your-worker.workers.dev/webhooks/ipaymu
   ```

### 7.5 Setup AI Provider

Konfigurasi AI melalui API:
```bash
curl -X PUT https://your-worker.workers.dev/api/ai/config \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "provider_url": "https://api.openai.com/v1",
    "api_key": "sk-proj-your-openai-key",
    "model_name": "gpt-4o-mini",
    "system_prompt": "Kamu adalah AI Sales Agent untuk [Nama Bisnis]. Kamu membantu pelanggan dengan ramah dalam Bahasa Indonesia. Kamu bisa menjelaskan produk, memproses pesanan, dan menjadwalkan appointment.",
    "max_tokens": 1024,
    "context_window": 20,
    "temperature": 0.7,
    "enabled": 1
  }'
```

**Provider alternatif:**
- Groq: `https://api.groq.com/openai/v1` (model: `llama-3.1-70b-versatile`)
- OpenRouter: `https://openrouter.ai/api/v1` (model: `anthropic/claude-3.5-sonnet`)
- Together AI: `https://api.together.xyz/v1` (model: `meta-llama/Llama-3-70b-chat-hf`)

---

## 8. Verifikasi Deployment

### Health Check
```bash
curl https://your-worker.workers.dev/health
# Expected: {"status":"ok","timestamp":"2024-..."}
```

### Test Authentication
```bash
curl https://your-worker.workers.dev/api/contacts \
  -H "Authorization: Bearer YOUR_CLERK_SESSION_TOKEN"
# Expected: {"data":[],"page":1,"pageSize":50,"total":0,"hasMore":false}
```

### Test AI Pipeline
Kirim pesan WhatsApp ke nomor yang terdaftar di Go-Wa. Jika AI config aktif, bot akan auto-reply.

---

## 9. Monitoring & Logs

### Real-time Logs
```bash
wrangler tail
```

### Dashboard Cloudflare
- **Workers Metrics**: https://dash.cloudflare.com → Workers → crm-cloudflare → Metrics
- **D1 Analytics**: https://dash.cloudflare.com → D1 → crm-database
- **Queue Metrics**: https://dash.cloudflare.com → Queues

### Error Alerts
Cek tabel `admin_alerts` untuk error:
```bash
wrangler d1 execute crm-database --command \
  "SELECT * FROM admin_alerts ORDER BY created_at DESC LIMIT 10"
```

---

## 10. Update & Redeploy

```bash
# Pull latest code
git pull origin feat/omnichannel-saas-crm

# Install new dependencies (if any)
npm install

# Run new migrations (if any)
wrangler d1 migrations apply crm-database

# Redeploy
wrangler deploy
```

---

## 11. Troubleshooting

| Problem | Solution |
|---------|----------|
| `401 Unauthorized` | Cek Clerk token masih valid, cek CLERK_SECRET_KEY |
| `403 Forbidden` | Cek organization ID sudah terdaftar di tabel `tenants` |
| `429 Too Many Requests` | Rate limit tercapai. Tunggu 60 detik atau naikkan limit |
| AI tidak reply | Cek AI config aktif (`enabled: 1`), cek token quota |
| Webhook tidak terima | Pastikan URL webhook benar, cek Go-Wa/iPaymu dashboard |
| D1 migration gagal | Cek syntax SQL, pastikan `database_id` benar |

---

## 12. Arsitektur Produksi (Recommended)

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Cloudflare    │     │   Go-Wa Server   │     │   AI Provider   │
│   Workers       │◄───►│   (Docker/VPS)   │     │  (OpenAI/Groq)  │
│   + D1/KV/R2    │     │                  │     │                 │
└────────┬────────┘     └──────────────────┘     └─────────────────┘
         │
         │ Webhooks
         ▼
┌─────────────────┐     ┌──────────────────┐
│     Clerk       │     │     iPaymu       │
│   (Auth/RBAC)   │     │  (Payments)      │
└─────────────────┘     └──────────────────┘
```

**Rekomendasi Hosting Go-Wa:**
- VPS (DigitalOcean/Vultr) dengan Docker
- Minimal: 1 vCPU, 1GB RAM
- Pastikan IP statis dan port 3000 terbuka

---

## License

MIT License - Free to use for commercial and personal projects.
