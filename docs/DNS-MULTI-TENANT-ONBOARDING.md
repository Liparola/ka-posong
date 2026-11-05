# 📡 ka-posong Multi-Tenant DNS Architecture & Domain Onboarding Guide
**Liparola Cloud Mail Suite & Server Infrastructure | Lesotho**
*Comprehensive DevOps Standard for Onboarding, Configuring, Exporting & Verifying Custom Tenant Domains*

---

## 1. Executive Architecture Overview

`ka-posong` couples **Cloudflare Edge Ingress & Egress** with a local **Stalwart SMTP/JMAP Mail Engine** and the **UMANG Phone Identity Engine** to deliver bespoke, multi-tenant mail hosting across Lesotho and Southern Africa.

Because local ISP/LTE uplinks and VPN interfaces (e.g. ProtonVPN `proton0`) block outbound SMTP Ports `25`, `465`, and `587`, `ka-posong` utilizes **HTTPS Port 443 bidirectional edge tunneling**:

```
[ External Senders (e.g. Gmail) ]
               │
               ▼ (Port 25 MX)
[ Cloudflare Inbound Email Routing ]
               │ (Raw unaltered RFC 5322 stream)
               ▼ (HTTPS Port 443 + HMAC-SHA256)
[ kaposong-email-ingress Worker ]
               │
               ▼ (Tailscale Funnel /ingest-email)
[ ka-posong Rust Control Plane & Stalwart Core ]
               │
               ▼ (Instant Push & Reactive SQLite Index)
[ uMail Lit+TS PWA (https://<tenant-domain>/umail) ]
               │
               ▼ (Reply / Compose via Outbound Dispatcher)
[ Cloudflare Email Sending Beta (REST API / Worker env.EMAIL) ] ──► [ Global External Inbox ]
```

---

## 2. Standard Master DNS Records Matrix

Every custom domain onboarded to `ka-posong` (e.g. `client.co.ls` or `liparola.org`) requires the following DNS records configured in their authoritative DNS provider (Cloudflare, Route53, Namecheap, cPanel):

| Type | Name / Host | Priority | Target / Value | Purpose |
| :--- | :--- | :---: | :--- | :--- |
| **MX** | `@` | `70` | `route1.mx.cloudflare.net.` | Primary Inbound Ingress Catch-All |
| **MX** | `@` | `52` | `route2.mx.cloudflare.net.` | Secondary Inbound Ingress |
| **MX** | `@` | `56` | `route3.mx.cloudflare.net.` | Tertiary Inbound Ingress |
| **MX** | `cf-bounce` | `70` | `route1.mx.cloudflare.net.` | Cloudflare Outbound Bounce Handler |
| **MX** | `cf-bounce` | `52` | `route2.mx.cloudflare.net.` | Cloudflare Outbound Bounce Secondary |
| **MX** | `cf-bounce` | `56` | `route3.mx.cloudflare.net.` | Cloudflare Outbound Bounce Tertiary |
| **TXT** | `@` | - | `"v=spf1 include:_spf.mx.cloudflare.net a:<mail-host> ~all"` | SPF Sender Authorization |
| **TXT** | `kaposong._domainkey` | - | `"v=DKIM1; k=ed25519; p=<PUBLIC_KEY>"` | Stalwart Cryptographic DKIM Key |
| **TXT** | `_dmarc` | - | `"v=DMARC1; p=quarantine; rua=mailto:postmaster@<domain>"` | DMARC Anti-Spoofing & Alignment |
| **CNAME**| `webmail` | - | `<primary_mail_hostname>` | Webmail & JMAP Gateway CNAME |

> [!IMPORTANT]
> **Priority Exact Match:** Cloudflare assigns priorities `70`, `52`, and `56` to `route1`, `route2`, and `route3`. Ensure these priorities are set verbatim.

---

## 3. Step-by-Step Tenant Onboarding Workflow

### Step 1: Provision the Tenant Domain in the Control Plane
1. Log in to the **Ops Managerial Dashboard** at `http://127.0.0.1:8443/ops` (or over Tailscale).
2. Click **+ Onboard New Client Domain**.
3. Fill in the organization details:
   - **Organization Name:** e.g. `Maluti Water Supplies`
   - **Primary Domain:** e.g. `malutiwater.co.ls`
   - **Business Tier:** `GROWTH` (3 Domains, 25 Mailboxes, 50 GB Quota)
   - **Admin Local Part:** `admin` (will become `admin@malutiwater.co.ls`)
   - **Admin Phone:** `+26658000001` (Bound to UMANG SMS/WhatsApp OTP login)
4. Click **Provision & Generate DNS Bundle**.
   - `ka-posong` generates a unique Ed25519 DKIM public key for this domain selector `kaposong._domainkey.malutiwater.co.ls`.
   - The initial admin mailbox is created and bound to the phone number.

---

### Step 2: Export & Apply the DNS Records

In the **Registered Tenant Domains** table on `/ops`:
1. Find `malutiwater.co.ls` and click **📋 View / Export DNS**.
2. Select your preferred deployment method:
   - **Option A (Cloudflare 1-Click Import):**
     Click **💾 Download .csv** (or **📋 Copy CSV**). In Cloudflare Dashboard, navigate to **DNS** $\rightarrow$ **Records** $\rightarrow$ **Import and Export** $\rightarrow$ **Import DNS records**, and upload the generated CSV file.
   - **Option B (BIND / Zone File):**
     Click **💾 Download .zone** (or **📋 Copy Zone**) to import into standard nameservers (BIND9, PowerDNS, Route53, Namecheap, cPanel Zone Editor).
   - **Option C (Manual Entry):**
     Copy each record individually from the **DNS Matrix Table** tab.

---

### Step 3: Enable Inbound Cloudflare Email Routing
1. In the domain's Cloudflare Dashboard, go to **Email Routing**.
2. Go to **Routing Rules** $\rightarrow$ **Catch-all rule**.
3. Set **Action:** `Send to a Worker` $\rightarrow$ Select `kaposong-email-ingress`.
4. Click **Save**. All incoming emails to `*@<domain>` now route through the Worker.

---

### Step 4: Enable Outbound Cloudflare Email Sending
1. Go to **Email Service** $\rightarrow$ **Email Sending (Beta)**.
2. Select the domain and click **Continue**.
3. Review the verified records (the `cf-bounce.<domain>` MX records) and click **Activate**.
4. Generate an API Token:
   - Click **Create Email Sending token** (with `Email Sending: Edit` permission).
   - Copy the token and add it to `ecosystem.config.cjs`:
     ```javascript
     CLOUDFLARE_API_TOKEN: 'your_api_token_here',
     CLOUDFLARE_ACCOUNT_ID: '5d34290efd0db9537a45b9bb167f6e7f',
     ```
   - *Or* configure the Worker binding `env.EMAIL` in `kaposong-email-ingress` Worker settings.

---

## 4. Verifying DNS Propagation with the Diagnostic Inspector

Run the built-in deep DNS inspector from your terminal to verify live propagation across Cloudflare 1.1.1.1 DoH and authorative nameservers:

```bash
./scripts/deep-dns-mail-inspector.sh malutiwater.co.ls admin@malutiwater.co.ls
```

The tool performs 7 verification stages:
1. **MX Records** (Checks priorities `70`, `52`, `56`)
2. **SPF TXT** (Checks `include:_spf.mx.cloudflare.net`)
3. **DKIM TXT** (Checks `kaposong._domainkey.<domain>`)
4. **DMARC TXT** (Checks `_dmarc.<domain>`)
5. **Bounce MX** (Checks `cf-bounce.<domain>`)
6. **HTTPS Ingress Ping** (Simulates Cloudflare Worker webhook HMAC)
7. **JMAP/Webmail CNAME** (Checks `webmail.<domain>`)

---

## 5. Multi-Tenant Export / Backup for Admins

To backup or audit all registered domains at once:
- In `/ops`, click **📤 Export All DNS**.
- This generates a single combined `.zone` file containing full BIND zone declarations for every active tenant on the system.
- Or query via API:
  ```bash
  curl -H "X-API-Key: devops-master-key" \
       https://aurum-thinkpad-t440p.tail8fafd0.ts.net/api/v1/admin/dns/export-all
  ```
