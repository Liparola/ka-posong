# KA-POSONG (`uMail`) Repeatable Client Domain Onboarding SOP
**End-to-End Standard Operating Procedure (Raw, Manual & Scripted)**
*Reference Implementation: `liparola.org` & `karabomilling.co.ls`*

---

## 1. Executive Architecture Overview

Every client onboarded onto the **Ka-Posong (`uMail`) Sovereign Communications Platform** receives:
1. **A Dedicated Multi-Tenant Namespace (`tnt_<domain_slug>`)** inside the Rust Control Plane (`kaposong-rust-control-plane` on `127.0.0.1:8443`; development host `aurum-thinkpad-t440p` at `100.83.242.97` / `aurum-thinkpad-t440p.tail8fafd0.ts.net`, production host `lipserver-optiplex-3040` at `100.109.250.50` / `lipserver-optiplex-3040.tail8fafd0.ts.net`).
2. **Sovereign Ed25519 DKIM Signing Keys (`kaposong._domainkey.<domain>`)** alongside Cloudflare Email Routing / Email Sending RSA DKIM records (`cf2024-1._domainkey` and `cf-bounce._domainkey`).
3. **UMANG Phone-Number-to-Mailbox Bindings** allowing passwordless OTP login via UMANG Core (`127.0.0.1:3000`), where an 8-digit Lesotho phone number (e.g., `53872233` $\rightarrow$ `+26653872233`) unlocks the user's `@<domain>` corporate mailbox.
4. **An Embedded `/umail` Progressive Web App (PWA)** deployed directly inside the client's existing Firebase Hosting website (`https://<domain>/umail`) so corporate email lives natively under their own domain with zero third-party webmail redirects.
5. **A Ready-to-Import Cloudflare BIND Zone File (`domains/<domain>.txt`)** formatted identically to Cloudflare's native Zone Export (`liparola.org (1).txt`), preserving the client's existing SOA, NS, and Firebase Hosting `A`/`TXT` records while adding all `MX`, `SPF`, `DKIM`, `DMARC`, and `CNAME` records in a single 1-click upload.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                   INBOUND & OUTBOUND EMAIL + AUTH FLOW                     │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  1. External Sender ──(SMTP)──► Cloudflare MX (route1/2/3.mx.cloudflare.net)│
│                                      │                                     │
│                                      ▼                                     │
│                        Cloudflare Email Worker                             │
│                        (kaposong-email-ingress)                            │
│                                      │                                     │
│                         POST /ingest-email (MIME)                          │
│                                      ▼                                     │
│  2. Ka-Posong Rust Control Plane (https://mail.liparola.org / :8443)       │
│     ├─ Stores MIME + metadata in SQLite (kaposong.db)                      │
│     ├─ Fires real-time WhatsApp alert via arm_<tenant>_wa                  │
│     └─ Serves REST API (/api/auth/*, /api/v1/messages, /api/v1/domains/*)  │
│                                      ▲                                     │
│                                      │                                     │
│  3. Client Website (https://<domain>/umail on Firebase Hosting)            │
│     ├─ Detects hostname (<domain>) via detectTenantDomain()                │
│     ├─ Loads active @<domain> identities from /api/v1/domains/<domain>/... │
│     └─ Authenticates user via UMANG 6-digit OTP (+266XXXXXXXX)             │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Fast-Track Automated Onboarding (1-Command Script)

Whenever a new client website and domain are ready to be onboarded, run `/home/aurum/Documents/Projects/ka-posong/scripts/onboard-client-domain.sh`.

### Command Syntax
```bash
cd /home/aurum/Documents/Projects/ka-posong

./scripts/onboard-client-domain.sh \
  "<ORGANIZATION_NAME>" \
  <DOMAIN> \
  <TIER: STARTER|GROWTH|ENTERPRISE> \
  <PRIMARY_ADMIN_LOCAL_PART> \
  <PRIMARY_ADMIN_PHONE> \
  [--mailbox <local_part>:<phone>]... \
  [--web-dir </absolute/path/to/client-website>]
```

### Exact Command Executed for `karabomilling.co.ls`
```bash
cd /home/aurum/Documents/Projects/ka-posong

./scripts/onboard-client-domain.sh \
  "Karabo Milling (Pty) Ltd" \
  karabomilling.co.ls \
  ENTERPRISE \
  info \
  53872233 \
  --mailbox linka:63483311 \
  --web-dir /home/aurum/Documents/karabomilling.co.ls
```

### What the Script Performs Automatically
1. **Normalizes Phone Numbers**: Converts `53872233` $\rightarrow$ `+26653872233` and `63483311` $\rightarrow$ `+26663483311`.
2. **Provisions Tenant & Primary Mailbox**: Calls `POST /api/v1/admin/tenants` on the Rust Control Plane to create tenant `tnt_karabomilling_co_ls`, domain `karabomilling.co.ls`, Ed25519 DKIM keypair, and `info@karabomilling.co.ls`.
3. **Provisions Additional Mailboxes**: Iterates through every `--mailbox <local_part>:<phone>` argument and calls `POST /api/v1/tenants/{tenant_id}/mailboxes` (creating `linka@karabomilling.co.ls` bound to `+26663483311`).
4. **Queries Live DNS + Control Plane DNS Bundle**: Runs `dig` against `<DOMAIN>` to capture live Cloudflare `SOA`, `NS`, and existing Firebase Hosting `A` (`199.36.158.100`) and `TXT` (`"hosting-site=..."`) records, merges them with `GET /api/v1/domains/<DOMAIN>/dns`, and writes:
   - `/home/aurum/Documents/Projects/ka-posong/domains/<DOMAIN>.txt` (exact Cloudflare BIND Zone export format)
   - `/home/aurum/Documents/Projects/ka-posong/domains/<DOMAIN>-DNS-SETUP.txt` (human-readable + JSON summary)
   - `<WEB_DIR>/<DOMAIN>-cloudflare-zone.txt` (copy in the client website repo)
5. **Builds & Injects Custom `uMail` PWA**: Compiles `umail-web-client` with `VITE_TENANT_DOMAIN="<DOMAIN>"` and `VITE_TENANT_NAME="uMail — <ORG_NAME>"` and copies the production bundle into `<WEB_DIR>/public/umail/`.

---

## 3. Raw & Manual Step-by-Step Process (Full Technical Breakdown)

If you are onboarding a tenant manually, auditing the system, or onboarding a new engineer, follow these exact 6 stages from start to finish.

---

### Stage 1: Provision Tenant, Domain & Mailboxes in the Control Plane

#### Option A: Via Raw REST API (`curl`)
Ensure the PM2 services (`kaposong-rust-control-plane` and `kaposong-umang-otp-bridge`) are running:
```bash
cd /home/aurum/Documents/Projects/ka-posong
./scripts/start-umang-daemons.sh status
```

1. **Create the Tenant, Domain, DKIM Keypair, and Primary Mailbox (`info@karabomilling.co.ls` $\rightarrow$ `+26653872233`)**:
   ```bash
   curl -sS -X POST "http://127.0.0.1:8443/api/v1/admin/tenants" \
     -H "Content-Type: application/json" \
     -H "X-API-Key: <MASTER_DEVOPS_KEY>" \
     -d '{
       "organization_name": "Karabo Milling (Pty) Ltd",
       "primary_domain": "karabomilling.co.ls",
       "tier": "ENTERPRISE",
       "admin_email_local_part": "info",
       "admin_phone": "+26653872233",
       "admin_initial_password": "<INITIAL_MAILBOX_SECRET>"
     }' | jq .
   ```

2. **Create the Second Mailbox (`linka@karabomilling.co.ls` $\rightarrow$ `+26663483311`)**:
   ```bash
   curl -sS -X POST "http://127.0.0.1:8443/api/v1/tenants/tnt_karabomilling_co_ls/mailboxes" \
     -H "Content-Type: application/json" \
     -H "X-API-Key: <MASTER_DEVOPS_KEY>" \
     -d '{
       "local_part": "linka",
       "domain_name": "karabomilling.co.ls",
       "phone": "+26663483311",
       "password": "<INITIAL_MAILBOX_SECRET>",
       "quota_mb": 10240
     }' | jq .
   ```

3. **Verify Domain Identities Endpoint**:
   ```bash
   curl -sS "http://127.0.0.1:8443/api/v1/domains/karabomilling.co.ls/identities" | jq .
   ```
   Expected response:
   ```json
   {
     "domain": "karabomilling.co.ls",
     "identities": [
       {
         "email": "info@karabomilling.co.ls",
         "local_part": "info",
         "phone": "+26653872233",
         "phone_digits": "53872233",
         "role": "admin"
       },
       {
         "email": "linka@karabomilling.co.ls",
         "local_part": "linka",
         "phone": "+26663483311",
         "phone_digits": "63483311",
         "role": "member"
       }
     ]
   }
   ```

#### Option B: Permanent Boot-Time Seeding in Rust (`rust-control-plane/src/main.rs`)
For flagship tenants (`liparola.org`, `karabomilling.co.ls`), their tenant record, deterministic Ed25519 DKIM keypair, mailbox bindings, welcome emails, and WhatsApp webhook arm (`arm_karabomilling_wa`) are also seeded idempotently inside `initialize_database_and_seed_liparola()` in `/home/aurum/Documents/Projects/ka-posong/rust-control-plane/src/main.rs` so that even if `kaposong.db` is recreated from scratch, the tenant is immediately restored on startup.

---

### Stage 2: Configure & Build the Multi-Tenant `uMail` Web Client (`umail-web-client`)

1. **Tenant Detection (`umail-web-client/src/services/auth.ts`)**:
   - `detectTenantDomain()` inspects:
     1. `?domain=<domain>` URL query parameter
     2. `window.location.hostname` (matching `karabomilling.co.ls`, `liparola.org`, or Firebase preview domains such as `weekly-observer.web.app` $\rightarrow$ `karabomilling.co.ls`)
     3. Build-time `import.meta.env.VITE_TENANT_DOMAIN`
   - `authService.fetchDomainIdentities(domain)` queries `GET /api/v1/domains/<domain>/identities` and populates the quick-select identity pills on the login screen (`+266 53872233 (info@karabomilling.co.ls)` and `+266 63483311 (linka@karabomilling.co.ls)`).

2. **Build Custom PWA Bundle for the Client Website**:
   ```bash
   cd /home/aurum/Documents/Projects/ka-posong/umail-web-client
   VITE_TENANT_DOMAIN="karabomilling.co.ls" \
   VITE_TENANT_NAME="uMail — Karabo Milling (Pty) Ltd" \
   npm run build
   ```

3. **Copy Compiled Bundle into the Client Website's `public/umail/` Directory**:
   ```bash
   mkdir -p /home/aurum/Documents/karabomilling.co.ls/public/umail
   rm -rf /home/aurum/Documents/karabomilling.co.ls/public/umail/*
   cp -r /home/aurum/Documents/Projects/ka-posong/umail-web-client/dist/* \
         /home/aurum/Documents/karabomilling.co.ls/public/umail/
   ```

---

### Stage 3: Integrate `/umail` into the Client Website & Firebase Hosting Config

In the target website repository (e.g., `/home/aurum/Documents/karabomilling.co.ls`):

1. **Update `firebase.json` Hosting Rewrites & Cache Headers**:
   Ensure `/umail` and `/umail/**` are rewritten to `/umail/index.html` *before* the catch-all `**` rewrite, and set `no-cache` headers on `/umail/index.html` and `/umail/sw.js`:
   ```json
   {
     "hosting": {
       "site": "weekly-observer",
       "public": "dist",
       "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
       "headers": [
         {
           "source": "/umail/index.html",
           "headers": [{ "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" }]
         },
         {
           "source": "/umail/sw.js",
           "headers": [{ "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" }]
         }
       ],
       "rewrites": [
         { "source": "/umail", "destination": "/umail/index.html" },
         { "source": "/umail/**", "destination": "/umail/index.html" },
         { "source": "**", "destination": "/index.html" }
       ]
     }
   }
   ```

2. **Bypass Client Website SPA Router for `/umail` (`src/lib/router.ts`)**:
   If the host website uses client-side History API link interception, exclude `/umail` so clicking the `uMail Inbox` button performs a clean browser navigation into the `/umail` PWA:
   ```ts
   if (url.pathname === '/umail' || url.pathname.startsWith('/umail/')) return;
   ```

3. **Add `uMail Inbox` Entry Point in Website Navigation (`src/components/site/site-nav.ts`)**:
   Add a direct link `<a href="/umail">uMail Inbox</a>` in the desktop and mobile navigation bars.

4. **Build & Deploy the Client Website**:
   ```bash
   cd /home/aurum/Documents/karabomilling.co.ls
   npm run build
   firebase deploy --only hosting
   ```
   *(Verify that `dist/umail/index.html`, `dist/umail/sw.js`, and `dist/umail/assets/*` are present in `dist/` after `npm run build`.)*

---

### Stage 4: Cloudflare DNS BIND Zone Export File (`karabomilling.co.ls.txt`)

To minimize manual work in Cloudflare, `ka-posong` generates a standards-compliant Cloudflare BIND Zone file at:
- `/home/aurum/Documents/Projects/ka-posong/domains/karabomilling.co.ls.txt`
- `/home/aurum/Documents/karabomilling.co.ls/karabomilling.co.ls-cloudflare-zone.txt`

This file matches the exact structure of `/home/aurum/Downloads/liparola.org (1).txt`:
- Preserves `karabomilling.co.ls` live SOA (`aida.ns.cloudflare.com.`) and NS (`aida.ns.cloudflare.com.`, `reese.ns.cloudflare.com.`)
- Preserves Firebase Hosting `A` record (`199.36.158.100`) and `TXT` record (`"hosting-site=weekly-observer"`)
- Adds `webmail.karabomilling.co.ls` CNAME $\rightarrow$ `mail.liparola.org`
- Adds root `MX` records (`56 route1.mx.cloudflare.net.`, `52 route2.mx.cloudflare.net.`, `70 route3.mx.cloudflare.net.`)
- Adds `cf-bounce.karabomilling.co.ls` `MX` and `SPF` records for Cloudflare Email Sending bounce handling
- Adds `_dmarc.karabomilling.co.ls` policy (`v=DMARC1; p=quarantine; sp=quarantine; rua=mailto:dmarc@karabomilling.co.ls; pct=100; adkim=r; aspf=r;`)
- Adds `cf2024-1._domainkey.karabomilling.co.ls` and `cf-bounce._domainkey.karabomilling.co.ls` 2048-bit RSA DKIM keys
- Adds `kaposong._domainkey.karabomilling.co.ls` Ed25519 DKIM key (`v=DKIM1; k=ed25519; p=NUIXvIJgMHvwvtkKJU84vEECVoFzZ6LxK23GbJOKN4Y=`)
- Adds root SPF record (`"v=spf1 include:_spf.mx.cloudflare.net ip4:197.155.71.158 ~all"`)

---

### Stage 5: Remaining Manual Operations in the Cloudflare Control Panel

Because the Cloudflare API token on the server (`CF_TOKEN`) is scoped strictly to Email Sending dispatch (and does not carry `Zone:DNS:Edit` or `Zone:Email Routing Rules:Edit` permissions), perform these **3 quick manual actions** in the Cloudflare Dashboard for `karabomilling.co.ls`:

#### Manual Action 1: Import the BIND Zone File (30 seconds)
1. Log into the **Cloudflare Dashboard** and select the **`karabomilling.co.ls`** zone.
2. In the left sidebar, go to **DNS** $\rightarrow$ **Records**.
3. Click **Import and Export** (top right) $\rightarrow$ **Import DNS records**.
4. Select the generated file:
   - `/home/aurum/Documents/Projects/ka-posong/domains/karabomilling.co.ls.txt` *(or `/home/aurum/Documents/karabomilling.co.ls/karabomilling.co.ls-cloudflare-zone.txt`)*
5. Click **Upload**. (Cloudflare will automatically skip any duplicate `A`/`TXT` records that already exist and add the 13 email routing, DKIM, DMARC, SPF, and `webmail` CNAME records in one shot.)

#### Manual Action 2: Bind Catch-All Inbound Email Routing to the `kaposong-email-ingress` Worker (30 seconds)
1. Still inside the **`karabomilling.co.ls`** zone in Cloudflare Dashboard, go to **Email** $\rightarrow$ **Email Routing** $\rightarrow$ **Routing rules**.
2. Under **Catch-all address**:
   - Click **Edit**.
   - Set **Action** to **Send to a Worker**.
   - Select **Destination**: **`kaposong-email-ingress`** (the exact same Email Worker already running in your Cloudflare account for `liparola.org`).
   - Toggle the Catch-all status to **Active** and click **Save**.
   *(Because `kaposong-email-ingress` extracts the full recipient address from the envelope and forwards the raw MIME to `https://mail.liparola.org/ingest-email`, no code changes to the Cloudflare Worker are required—it is natively multi-tenant!)*

#### Manual Action 3: Enable Outbound Email Sending for `karabomilling.co.ls` (Optional / 15 seconds)
1. Inside the **`karabomilling.co.ls`** zone, go to **Email** $\rightarrow$ **Email Sending (Beta)** (or **Outbound**).
2. Click **Enable / Activate Email Sending** for `karabomilling.co.ls`.
3. Note: If Cloudflare regenerates a zone-specific `cf2024-1._domainkey` or `cf-bounce._domainkey` public key during activation, allow Cloudflare to overwrite those two `cf*._domainkey` TXT records while keeping `kaposong._domainkey.karabomilling.co.ls` intact.

---

### Stage 6: Post-Onboarding Verification Checklist

Run these commands from `/home/aurum/Documents/Projects/ka-posong` to verify every layer of the stack:

1. **Verify Live DNS Propagation (after uploading the BIND file in Cloudflare)**:
   ```bash
   ./scripts/deep-dns-mail-inspector.sh karabomilling.co.ls
   ```

2. **Verify Passwordless UMANG OTP Login for `info@karabomilling.co.ls` (`53872233`)**:
   ```bash
   OTP=$(curl -sS -X POST http://127.0.0.1:8443/api/auth/request-otp \
     -H "Content-Type: application/json" \
     -d '{"phone":"53872233","domain":"karabomilling.co.ls"}' | jq -r '.dev_otp_preview')

   curl -sS -X POST http://127.0.0.1:8443/api/auth/verify-otp \
     -H "Content-Type: application/json" \
     -d "{\"phone\":\"53872233\",\"otp\":\"$OTP\",\"domain\":\"karabomilling.co.ls\"}" | jq .
   ```

3. **Verify Passwordless UMANG OTP Login for `linka@karabomilling.co.ls` (`63483311`)**:
   ```bash
   OTP=$(curl -sS -X POST http://127.0.0.1:8443/api/auth/request-otp \
     -H "Content-Type: application/json" \
     -d '{"phone":"63483311","domain":"karabomilling.co.ls"}' | jq -r '.dev_otp_preview')

   curl -sS -X POST http://127.0.0.1:8443/api/auth/verify-otp \
     -H "Content-Type: application/json" \
     -d "{\"phone\":\"63483311\",\"otp\":\"$OTP\",\"domain\":\"karabomilling.co.ls\"}" | jq .
   ```

4. **Simulate Inbound MIME Email Delivery to Both Mailboxes**:
   ```bash
   curl -sS -X POST http://127.0.0.1:8443/ingest-email \
     -H "X-Bridge-Secret: <BRIDGE_SECRET>" \
     -H "X-Envelope-From: test@liparola.org" \
     -H "X-Envelope-To: info@karabomilling.co.ls" \
     --data-binary $'From: Liparola <test@liparola.org>\r\nTo: info@karabomilling.co.ls\r\nSubject: Welcome Karabo Milling\r\n\r\nYour sovereign uMail inbox is live!'
   ```

5. **Fetch Authenticated Inbox Messages via `/api/umail/messages`**:
   ```bash
   curl -sS "http://127.0.0.1:8443/api/umail/messages?folder=inbox" \
     -H "Authorization: Bearer $TOKEN" | jq .
   ```
