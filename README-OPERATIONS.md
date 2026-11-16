# ka-posong — Multi-Tenant Business Mail & Operations Handbook

**ka-posong** is Liparola's multi-tenant cloud business email suite and UMANG phone-first identity control plane. It delivers enterprise-grade email hosting with **Cloudflare Edge routing**, **Stalwart Core engine**, **Lesotho mobile (+266) passwordless OTP authentication**, **120MB attachment transmission**, and an embedded **Super Manager Multi-Tenant Operations Dashboard**.

---

## 1. Quick Access Directory & Service Endpoints

> **Two-Host Topology Note:**
> - **Development Host (`aurum-thinkpad-t440p`):** `100.83.242.97` / `https://aurum-thinkpad-t440p.tail8fafd0.ts.net`
> - **Production Host (`lipserver-optiplex-3040`):** `100.109.250.50` / `https://lipserver-optiplex-3040.tail8fafd0.ts.net`

| Portal / Interface | Production / Development URL | Local Loopback URL | Purpose |
| :--- | :--- | :--- | :--- |
| **Super Manager Dashboard** | `https://lipserver-optiplex-3040.tail8fafd0.ts.net/ops` (Prod) / `https://aurum-thinkpad-t440p.tail8fafd0.ts.net/ops` (Dev) | `http://127.0.0.1:8443/ops` | Multi-tenant organization control, domain onboarding, DNS exports, mailbox creation & deletion |
| **uMail Web Client (PWA)** | `https://liparola.org/umail` | `http://127.0.0.1:8443/umail` (or `:5176` Vite dev) | Flagship webmail client with thread conversation view, 120MB attachments, and Trash purge |
| **UMANG Core Identity** | `http://127.0.0.1:3000` | `http://127.0.0.1:3000/api/health` | Shared UMANG OIDC/PKCE & WhatsApp/SMS OTP dispatch engine |
| **Rust Control Plane Gateway** | `https://lipserver-optiplex-3040.tail8fafd0.ts.net` (Prod) / `https://aurum-thinkpad-t440p.tail8fafd0.ts.net` (Dev) | `http://127.0.0.1:8443` | Ingress MIME webhook receiver, JMAP REST API, and SMTPS Port 465 relay |

---

## 2. Super Manager Dashboard (`/ops`)

The **Super Manager Dashboard** is the single pane of glass for managing tenants, onboarding client domains, and provisioning or deleting user mailboxes.

### How to Access the Dashboard in Your Browser
1. Open your browser and navigate to:
   - **Local Loopback**: [http://127.0.0.1:8443/ops](http://127.0.0.1:8443/ops)
   - **Production (via Tailscale)**: `https://lipserver-optiplex-3040.tail8fafd0.ts.net/ops`
   - **Development (via Tailscale)**: `https://aurum-thinkpad-t440p.tail8fafd0.ts.net/ops`
2. Authenticate using your host-configured **DevOps Master Key** (`<MASTER_DEVOPS_KEY>`) to establish an `HttpOnly` operator session cookie for administrative actions.

---

## 3. Step-by-Step Operator & Sales Guides

### A. Onboarding a New Client Domain & Organization
When a new customer signs up for business email hosting:

1. Click the golden **`+ Onboard New Client Domain`** button in the top right header of the dashboard.
2. Fill in the organization details:
   - **Organization Name**: e.g., `Mantsopa Institute of Technology`
   - **Primary Domain**: e.g., `mantsopa.co.ls` (or any sub-tenant domain under `liparola.org`)
   - **Business Tier**:
     - **STARTER**: 1 domain, 5 mailboxes, 10 GB total quota (Best for small shops & sole proprietors)
     - **GROWTH**: 3 domains, 25 mailboxes, 50 GB total quota (Best for medium businesses & legal firms)
     - **ENTERPRISE**: Unlimited domains & mailboxes, 500 GB+ quota (Best for corporates & institutions)
   - **Admin Email Local Part**: e.g., `admin` or `principal` (creates `admin@mantsopa.co.ls`)
   - **Admin Phone (UMANG +266)**: Lesotho mobile number of the customer's IT officer (e.g., `+26658001234`)
3. Click **Provision & Generate DNS Bundle**:
   - The engine automatically provisions the organization tenant, registers the domain, generates a dedicated cryptographic Ed25519 **DKIM key pair**, and binds the admin phone for instant OTP login.

### B. Exporting & Applying DNS Records
Every tenant domain requires DNS records for email delivery and security:

1. In Table 2 (**Registered Tenant Domains & Auto-DKIM Keys**), locate the customer's domain and click **`📋 View / Export DNS`**.
2. A tabbed modal will open showing:
   - **DNS Matrix Table**: Interactive list of `MX`, `TXT (SPF)`, `TXT (DKIM)`, `TXT (DMARC)`, and `CNAME (Webmail)` records with 1-click "Copy" buttons.
   - **BIND Zone File**: Standard RFC 1035 format. Click **`💾 Download .zone`** for cPanel, Route53, or Namecheap import.
   - **Cloudflare CSV**: Standard CSV format. Click **`💾 Download .csv`** and import directly via Cloudflare Dashboard (`DNS` -> `Records` -> `Import`).
3. To export records for **all clients simultaneously**, click **`📤 Export All DNS`** in the top header.

### C. Creating Custom Email Addresses on a Tenant
To create additional employee mailboxes (e.g., on `liparola.org` or client domains):

1. Scroll to Table 3 (**UMANG Phone-to-Mailbox Identity Directory**) and click **`+ Provision Mailbox`**.
2. Specify:
   - **Tenant ID**: `tnt_liparola_org` (or customer tenant ID)
   - **Email Address**: e.g., `finance@liparola.org` or `support@liparola.org`
   - **Lesotho Phone (+266########)**: The employee's mobile number (e.g., `+26657284264` or `+26658088117`)
   - **Display Name**: e.g., `Finance Department`
3. Click **Create Mailbox**:
   - The mailbox is immediately active. The user can open [https://liparola.org/umail](https://liparola.org/umail), enter their phone number, receive a 6-digit OTP via WhatsApp/SMS, and log in without needing to remember a password.

### D. Deleting Test Email Accounts (Deployment Readiness Test)
To verify lifecycle cleanups or delete temporary test mailboxes:

1. In Table 3 (**UMANG Phone-to-Mailbox Identity Directory**), locate the test mailbox you wish to delete.
2. In the rightmost **Actions** column, click the red **`🗑️ Delete`** button.
3. Confirm the browser prompt:
   ```text
   Are you sure you want to permanently delete mailbox "test@liparola.org"?
   This will remove the mailbox, unbind the phone from UMANG, and purge all its messages.
   ```
4. Click **OK**:
   - The system calls `DELETE /api/v1/mailboxes/{email}`.
   - The mailbox record is deleted from SQLite.
   - All associated messages and attachments stored in the inbox/sent tables are purged.
   - The account is de-registered from Stalwart.
   - The tenant's used mailbox counter is automatically decremented.
   - The table reloads, demonstrating clean lifecycle teardown and deployment readiness.

---

## 4. uMail Web Client & Permanent Trash Purge

The uMail client at [https://liparola.org/umail](https://liparola.org/umail) includes a cloud-synchronized **Trash Purge** system:

### Moving Messages to Trash
- When viewing any conversation thread, click **`🗑 Trash`** in the thread header to move all messages in that thread into the Trash folder.

### Emptying Trash Permanently
1. In the left navigation menu, click **`🗑️ Trash`**.
2. When viewing the Trash folder, a red action banner appears:
   ```
   ⚠️ Messages in Trash can be permanently purged. This will delete all trashed messages and attachments from local and cloud storage.
   [ 🗑️ Empty Trash Now ]
   ```
3. Click **`🗑️ Empty Trash Now`** (either in the banner or in the top toolbar).
4. Confirm the prompt:
   ```text
   Are you sure you want to permanently delete all messages in Trash?
   This will permanently purge all trashed messages and attachments from local and cloud storage.
   This action cannot be undone.
   ```
5. All trashed messages and attachments are permanently purged across both the local client IndexedDB cache and the Control Plane SQLite store (`DELETE FROM mail_messages WHERE mailbox_email = ? AND folder = 'trash'`).
6. A confirmation toast appears: `✓ Trash emptied permanently. X message(s) deleted.`

### Permanent Deletion of a Single Conversation in Trash
- If you open a specific conversation thread inside Trash, the action bar provides two options:
  - **`↩ Restore to Inbox`**: Moves the conversation back to the Active Inbox.
  - **`❌ Delete Permanently`**: Hard-deletes that specific conversation thread immediately without affecting other trashed items.

---

## 5. Commercial & Sales Guide: Selling ka-posong Business Mail

Use this section to articulate the business value when presenting to prospective enterprise and SME clients in Lesotho:

### Key Selling Points & Commercial Advantages

| Value Proposition | Customer Benefit | Competitive Edge vs. Microsoft 365 / Google Workspace |
| :--- | :--- | :--- |
| **Local Currency Billing (LSL/Maloti)** | Clients pay locally via EFT, M-Pesa, or EcoCash without foreign currency exchange rate fluctuation or credit card bank limits. | Microsoft and Google require USD/ZAR credit cards that frequently fail due to banking limits. |
| **UMANG Phone-First Identity** | Passwordless login using Lesotho numbers (`+266`). Employees receive OTPs directly on WhatsApp or SMS. Zero IT tickets for forgotten passwords. | Microsoft 365 password expiry policies confuse non-technical staff and create frequent IT lockouts. |
| **120MB Attachment Capacity** | Teams can send large engineering drawings, blueprints, PDFs, and legal briefs up to 120MB directly in their emails. | Standard email providers cap attachments at 20MB–25MB, forcing users to use third-party WeTransfer or Google Drive links. |
| **Cloudflare Edge Protection** | 100% spam, spoofing, and phishing protection at Cloudflare's global edge network before messages ever touch the client's inbox. | Enterprise-grade perimeter defense included standard across all tiers. |
| **1-Click Tenant Onboarding** | Customers can keep their existing domain registrar (e.g. `.co.ls` with Leo / Telecom Lesotho) and simply paste our generated DNS records. | Frictionless migration with zero downtime. |

### Suggested Commercial Pricing Tiers (Proposal — Subject to Business & Finance Sign-Off)

> **Governance Note:** The tiers and prices below are illustrative commercial proposals. Refer to the approved Liparola service catalog and signed customer contracts as the binding authority before quoting or invoicing.

1. **Starter Tier (Proposed: M199 / month)**
   - 1 Domain (`company.co.ls`)
   - Up to 5 Mailboxes
   - 10 GB Cloud Storage
   - WhatsApp / SMS OTP Login

2. **Growth Tier (M499 / month)**
   - Up to 3 Domains
   - Up to 25 Mailboxes
   - 50 GB Cloud Storage
   - Extending Arm Webhooks (CRM & WhatsApp notifications)

3. **Enterprise Tier (M1,299 / month)**
   - Unlimited Domains & Mailboxes
   - 500 GB+ Cloud Storage
   - Priority Outbound Relay & Dedicated IP
   - 24/7 Local Support

---

## 6. Service Management & CLI Operations

Both core daemons are monitored and managed using PM2:

```bash
# Check status of both services
npx pm2 list

# View live logs of the Rust Control Plane
npx pm2 logs kaposong-rust-control-plane

# View live logs of the UMANG OTP Bridge
npx pm2 logs kaposong-umang-otp-bridge

# Restart the Control Plane after configuration changes
npx pm2 restart kaposong-rust-control-plane
```

---

## 7. Web Client Pro Features (Gmail-Grade Architecture)

The uMail Web Client (`https://liparola.org/umail` and `https://liparola-ls.web.app`) incorporates industry-leading desktop email client features engineered for stability, user trust, and speed:

### 1. Multi-Recipient To, Cc, and Bcc Routing
- **Multiple Target Recipients:** Both `To`, `Cc`, and `Bcc` fields support multiple email addresses separated by commas, semicolons, or whitespace (e.g. `client@domain.co.ls, manager@liparola.org; director@corp.com`).
- **Collapsible Cc & Bcc Rows:** Clean `+ Cc` and `+ Bcc` quick-toggle buttons in the `To` field keep the interface uncluttered while offering instant expansion.
- **RFC 5322 §3.6.3 Strict Privacy Compliance:**
  - `To` and `Cc` addresses are written into visible MIME headers.
  - `Bcc` recipients are **strictly omitted** from wire headers to prevent recipient disclosure, while being individually relayed in the SMTP envelope (`RCPT TO:<addr>`).
  - Local tenant mailboxes across `To`, `Cc`, and `Bcc` receive instant database delivery into their respective inboxes.

### 2. Auto-Save Drafts in Background (Feature 1)
- **Zero-Friction Auto-Save:** As the user types in `To`, `Cc`, `Bcc`, `Subject`, `Message Body`, or attaches files, drafts are debounced and persistently stored in `localStorage` and `IndexedDB`.
- **Live Status Indicator:** Real-time indicator in the header and formatting toolbar shows `⏳ Saving draft...` and `☁️ Saved HH:MM:SS`.
- **Automatic Recovery:** Re-opening the compose modal automatically restores any unsaved draft with a `"Restored unsaved draft"` banner.
- **One-Click Discard:** A `🗑️ Discard Draft` button purges the cached draft and resets all fields.
- **Automatic Cleanup:** Sent drafts are instantly purged upon successful delivery.

### 3. "Undo Send" 7-Second Grace Countdown (Feature 2)
- **Floating Countdown Snackbar:** When clicking "🚀 Send Email" or pressing `Ctrl+Enter`, the compose modal closes and a sleek floating snackbar appears:
  `[ ⏱️ Sending message to <recipient> in 7s... ] [UNDO] [SEND NOW]`
  accompanied by an animated thin countdown bar.
- **Instant Abort & Edit Restoration:** Clicking `UNDO` aborts outbound transmission immediately and re-opens the composer with all text, formatting, recipients, and up to 120MB attachments intact.
- **Immediate Dispatch:** Clicking `SEND NOW` skips the countdown and dispatches immediately via Cloudflare SMTPS Port 465.

### 4. Rich Text Formatting Toolbar & Pro Keyboard Shortcuts (Feature 3)
- **Formatting Toolbar:** Dedicated action bar above the message body providing:
  - **Bold** (`**text**`)
  - *Italic* (`*text*`)
  - <u>Underline</u> (`_text_`)
  - Blockquote (`> text`)
  - Bulleted Lists (`- item`)
  - Numbered Lists (`1. item`)
  - Monospace / Code blocks (`` `code` `` and ```` ```code``` ````)
  - Clear formatting (`Tx`)
- **Pro Keyboard Shortcuts:**
  - `Ctrl + Enter` (or `Cmd + Enter`): Send email or trigger Undo countdown immediately from modal or inline reply.
  - `Escape`: Safely close modal (draft auto-saves).
  - `Ctrl + B` / `Cmd + B`: Toggle **bold** on selected text.
  - `Ctrl + I` / `Cmd + I`: Toggle *italic* on selected text.
  - `Ctrl + U` / `Cmd + U`: Toggle <u>underline</u> on selected text.
- **Multipart MIME Engine:** Formatted messages automatically generate rich `text/html` and `text/plain` alternative bodies, displaying beautifully in Gmail, Outlook, Apple Mail, and mobile clients.

