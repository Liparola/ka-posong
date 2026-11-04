# ka-posong — Operations, Architecture & Tenant Onboarding Guide

**ka-posong** is Liparola's bespoke multi-tenant business mail hosting suite and UMANG phone-first identity control plane for Lesotho organizations.

---

## 1. Suite Architecture & Directory Layout

```text
ka-posong/
├── .env.example
├── docker-compose.yml
├── README-OPERATIONS.md
├── traefik/
│   ├── traefik.yml
│   └── dynamic.yml
├── stalwart/
│   └── config.toml
├── cloudflare-edge/
│   ├── email-ingress-worker.js
│   └── wrangler.toml.example
├── rust-control-plane/
│   ├── Dockerfile
│   ├── Cargo.toml
│   ├── migrations/
│   │   └── 001_init_tenants_and_arms.sql
│   └── src/
│       ├── main.rs
│       ├── auth.rs           # RBAC: DEVOPS_MASTER, TENANT_ADMIN, EXTENDING_ARM, UMAIL_USER
│       ├── tiers.rs          # STARTER, GROWTH, ENTERPRISE hard quota enforcement
│       ├── stalwart_api.rs   # Stalwart Management API & JMAP client trait + Auto-DKIM
│       ├── smtp_injector.rs  # Raw RFC822 MIME -> Local Stalwart Port 25/LMTP async injector
│       ├── arms_webhook.rs   # HMAC-SHA256 Event dispatcher for external CRM/ERP/WhatsApp modules
│       ├── umang_auth.rs     # UMANG Lesotho Phone (+266) -> OTP -> 8h JWT Identity Engine
│       ├── umail_api.rs      # uMail PWA JMAP/REST inbox, search, and outbound send endpoints
│       └── dashboard.rs      # Embedded HTMX/Tailwind Admin & DevOps Managerial UI (/ops)
├── umail-web-client/         # LitHTML + TypeScript PWA served at /umail on every tenant domain
├── umang-otp-bridge/         # Multi-Channel OTP Delivery Service (WhatsApp AetherWA + Huawei SMS)
├── domains/                  # Generated Plug-and-Play DNS setup bundles per tenant domain
└── scripts/
    ├── bootstrap-stack.sh
    ├── onboard-client-domain.sh
    └── verify-integration.sh
```

---

## 2. Quick Start & Local Tailscale Funnel Setup

### Step 1: Bootstrap the Stack
```bash
./scripts/bootstrap-stack.sh
```

### Step 2: Expose via Tailscale Funnel (Zero Static IP Cost)
Your workstation's active Tailscale node is `aurum-thinkpad-t440p.tail8fafd0.ts.net` (`100.83.242.97`).
```bash
sudo tailscale up --ssh
sudo tailscale funnel --bg --https=443 http://127.0.0.1:8443
```
*(When running `rust-control-plane` directly on host port `3000` without Traefik, point Funnel to `http://127.0.0.1:3000`.)*

---

## 3. Exact Cloudflare DNS Setup Instructions for `liparola.org` (First Tenant)

In your Cloudflare Dashboard for **`liparola.org`** (`DNS` -> `Records`), keep your two existing Firebase Hosting records (`A 199.36.158.100` and `TXT "hosting-site=liparola-ls"`), and click **+ Add record** to add the following records:

| Type | Name | Content / Target | Priority | Proxy Status | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **MX** | `@` | `route1.mx.cloudflare.net` | `10` | DNS only | Cloudflare Email Routing Primary Catch-All |
| **MX** | `@` | `route2.mx.cloudflare.net` | `20` | DNS only | Cloudflare Email Routing Secondary MX |
| **MX** | `@` | `route3.mx.cloudflare.net` | `30` | DNS only | Cloudflare Email Routing Tertiary MX |
| **TXT** | `@` | `"v=spf1 include:_spf.mx.cloudflare.net a:aurum-thinkpad-t440p.tail8fafd0.ts.net ~all"` | — | DNS only | SPF Sender Authorization |
| **TXT** | `kaposong._domainkey` | `"v=DKIM1; k=ed25519; p=hJQosMmIpddr923JaG8n2p3rT7vW9yB2eF5hJ8kL1mN="` | — | DNS only | Stalwart DKIM Public Key |
| **TXT** | `_dmarc` | `"v=DMARC1; p=quarantine; rua=mailto:postmaster@liparola.org"` | — | DNS only | DMARC Anti-Spoofing Policy |
| **CNAME** | `webmail` | `aurum-thinkpad-t440p.tail8fafd0.ts.net` | — | DNS only | Direct Webmail & JMAP Gateway |

### Step 4: Connect Cloudflare Email Worker
1. In Cloudflare Dashboard -> **Email** -> **Email Routing** -> **Email Workers**, deploy [`cloudflare-edge/email-ingress-worker.js`](file:///home/aurum/Documents/Projects/ka-posong/cloudflare-edge/email-ingress-worker.js).
2. Set `TUNNEL_INGEST_URL` to `https://aurum-thinkpad-t440p.tail8fafd0.ts.net/ingest-email` and `BRIDGE_SECRET` to match your `.env`.
3. Enable the **Catch-All** rule on `liparola.org` and route it to the Worker.

---

## 4. Onboarding Additional Client Domains

Run the CLI wrapper:
```bash
./scripts/onboard-client-domain.sh "Mantsopa Institute" mantsopa.co.ls GROWTH admin +26657893042
```
Or use the 1-Click **"Onboard New Client Domain"** modal in the Managerial Dashboard at `http://100.83.242.97:3000/ops`.
