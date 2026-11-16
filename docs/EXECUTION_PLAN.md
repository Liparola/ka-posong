# Ka-Posong (`uMail`) Portfolio Execution & Operations Plan

**Product:** Ka-Posong (`ka-posong`)  
**Repository:** `/home/aurum/Documents/Projects/ka-posong`  
**Canonical UMANG Tenant / Client IDs:** `tnt_ka_posong` / `umang_pk_ka_posong`  
**References:**
- [`PORTFOLIO_OPERATING_MODEL.md`](../../../deployment-flows/docs/PORTFOLIO_OPERATING_MODEL.md)
- [`PLATFORM_INTEGRATION_STANDARD.md`](../../../deployment-flows/docs/PLATFORM_INTEGRATION_STANDARD.md)
- [`TWO_HOST_DEPLOYMENT_RUNBOOK.md`](../../../deployment-flows/docs/TWO_HOST_DEPLOYMENT_RUNBOOK.md)
- [`PORT_AND_SERVICE_MANIFEST.md`](../../../deployment-flows/docs/PORT_AND_SERVICE_MANIFEST.md)

---

## 1. Product Role & Boundary

**Ka-Posong** (`ka-posong` repository) is Liparola's **managed domain and business-mail service**, powering the `uMail` webmail experience, customer mail tenants, domains, mailboxes, DNS provisioning bundles (`MX`, `SPF`, `DKIM`, `DMARC`), mail service quotas, and inbound/outbound MIME operations.

### Strict Separation from Ka Sesiung
- **Ka-Posong** owns domain onboarding, mailbox lifecycles, DKIM cryptographic key management, Stalwart mail engine synchronization, Cloudflare email ingress/egress routing, and mailbox-level authorization.
- **Ka Sesiung** (`ka.sesiung` repository) is the **client and Liparola-collaborator workspace** owning client accounts, project progress, deliverables, and the controlled document vault.
- Never conflate Ka-Posong mail tenant administration with Ka Sesiung workspace/vault authorization, and never treat a valid UMANG session token as blanket access across unrelated domains or mailboxes.

### Identity & Authorization Contract
- **UMANG Core** (`127.0.0.1:3000`) is the authoritative identity provider (`tnt_ka_posong`, OIDC/OAuth 2.0 + PKCE `S256` and phone-first OTP dispatch).
- **Ka-Posong Control Plane** (`127.0.0.1:8443`) enforces per-tenant and per-mailbox authorization, business tier limits (`HTTP 402 Payment Required` on domain/mailbox overflow), and webhook HMAC verification.
- In production (`APP_ENV=production`), local in-memory OTP fallback (`ALLOW_LOCAL_OTP_FALLBACK=false`) and deterministic SHA-256 DKIM placeholder claims (`ALLOW_DETERMINISTIC_DKIM_FALLBACK=false`) are disabled by default so operators never bypass UMANG Core or publish non-cryptographic DKIM records to live DNS.

---

## 2. Two-Host Topology & External Provider Exceptions

Self-managed application compute for Ka-Posong operates strictly across two named Tailscale hosts:

| Environment | Hostname | Tailscale IPv4 | Tailscale IPv6 | Full Tailscale FQDN | Responsibility |
|---|---|---|---|---|---|
| **Development / Integration** | `aurum-thinkpad-t440p` | `100.83.242.97` | `fd7a:115c:a1e0::4a01:f2a2` | `aurum-thinkpad-t440p.tail8fafd0.ts.net` | Feature development, isolated E2E verification (`scripts/verify-integration.sh`), synthetic test data |
| **Production** | `lipserver-optiplex-3040` | `100.109.250.50` | `fd7a:115c:a1e0::8634:fa33` | `lipserver-optiplex-3040.tail8fafd0.ts.net` | Reviewed immutable releases, customer mail tenants, live Stalwart volumes, encrypted backups |

### Approved External Managed Provider Exceptions
While all control-plane and mail-engine compute runs on the two self-managed hosts above, the following external SaaS boundaries are explicitly approved for Ka-Posong (with strict dev vs. prod secret separation):
1. **Cloudflare Edge (DNS & Email Routing Worker)**:
   - Authoritative DNS hosting (`MX`, `SPF`, `DKIM`, `DMARC`, `CNAME`) for managed client domains.
   - Inbound Email Routing Worker (`cloudflare-edge/email-ingress-worker.js`) that verifies and tunnels raw RFC 822 MIME payloads over HTTPS (`POST /ingest-email`) with `X-Bridge-Secret` / `X-Ingress-HMAC-Signature` to the active host (`env.development` -> `aurum-thinkpad-t440p.tail8fafd0.ts.net`, `env.production` -> `lipserver-optiplex-3040.tail8fafd0.ts.net`).
   - Outbound Cloudflare Email Sending / SMTPS relay (`smtp.mx.cloudflare.net:465`).
2. **Firebase Hosting (Static Webmail Assets)**:
   - Optional static hosting of the compiled `umail-web-client/dist` PWA under client domain `/umail` routes (e.g., `https://<domain>/umail`), or direct serving from the Rust Control Plane's `/umail` static handler on the OptiPlex production host.

---

## 3. Canonical Port & Service Allocation

To allow Ka-Posong, UMANG Core, Linka (`:3001`/`:3002`), and Ka Sesiung (`:3003`) to run side-by-side on the same host without port collisions or cross-service daemon kills:

| Port | Bind Interface | Service / Container | Process Manager | Health Check | Notes |
|---|---|---|---|---|---|
| `8443` | `127.0.0.1` | `kaposong-rust-control-plane` | PM2 (`ecosystem.config.cjs`) / Docker | `http://127.0.0.1:8443/api/health` | Primary Ka-Posong REST API, `/ops` dashboard, `/umail` static server, and `/ingest-email` webhook receiver |
| `3000` | `127.0.0.1` | `umang-core-platform` | PM2 | `http://127.0.0.1:3000/api/health` | Shared UMANG identity, OIDC/PKCE, OTP vault, and tenant control plane |
| `2525` | `127.0.0.1` | `kaposong-stalwart` (SMTP) | Docker Compose | TCP `127.0.0.1:2525` | Internal SMTP injection port from Rust Control Plane to Stalwart |
| `587` | `127.0.0.1` | `kaposong-stalwart` (Submission) | Docker Compose | TCP `127.0.0.1:587` | Authenticated mail submission |
| `993` | `127.0.0.1` | `kaposong-stalwart` (IMAPS) | Docker Compose | TCP `127.0.0.1:993` | Encrypted IMAP access |
| `8080` | `127.0.0.1` | `kaposong-stalwart` (Admin/JMAP) | Docker Compose | `http://127.0.0.1:8080` | Stalwart management API & JMAP (strictly loopback-bound; never expose publicly) |
| `5176` | `127.0.0.1` | `umail-web-client` (Vite dev) | `npm run dev` | `http://127.0.0.1:5176/umail/` | Dedicated development server port for `umail-web-client` |

> **Co-Hosting Rule:** `scripts/start-umang-daemons.sh` manages only `umang-core-platform` (`:3000`) and `kaposong-rust-control-plane` (`:8443`). It must never stop or delete `linka-backend` (`:3002`) or other sibling portfolio services.

---

## 4. Backup, DKIM Key Protection, and Restore Verification Procedures

A database-only backup is insufficient to restore a mail service. Operators must back up three coordinated artifacts before any production release or schema migration on `lipserver-optiplex-3040`:

### 4.1 SQLite WAL Online Backup (`control_plane.db`)
Because `rust-control-plane` uses SQLite in WAL mode, never copy `control_plane.db` with plain `cp` while the service is writing. Use SQLite's online `.backup` command:

```bash
BACKUP_DIR="/var/backups/ka-posong/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

# Perform online WAL-safe backup of control_plane.db
sqlite3 /home/aurum/Documents/Projects/ka-posong/rust-control-plane/control_plane.db \
  ".backup '${BACKUP_DIR}/control_plane.db'"

# Verify integrity of the backed-up SQLite database
sqlite3 "${BACKUP_DIR}/control_plane.db" "PRAGMA integrity_check;"
```

### 4.2 Stalwart Mail Volume & Cryptographic DKIM Private Key Backup
Back up the `stalwart-data` Docker volume (which stores JMAP/IMAP blobs, principal state, and Ed25519/RSA DKIM private signing keys) along with domain DNS zone bundles:

```bash
# 1. Export domain metadata & DKIM public key records from SQLite
sqlite3 -header -csv "${BACKUP_DIR}/control_plane.db" \
  "SELECT domain_name, tenant_id, dkim_selector, dkim_public_key, verified_at FROM domains;" \
  > "${BACKUP_DIR}/domains_dkim_inventory.csv"

# 2. Snapshot Stalwart named volume (contains DKIM private keys & mail blobs)
docker run --rm \
  -v ka-posong_stalwart-data:/opt/stalwart-mail:ro \
  -v "${BACKUP_DIR}:/backup" \
  alpine tar -czf /backup/stalwart-data.tar.gz -C /opt/stalwart-mail .

# 3. Encrypt backup archive for off-host recovery copy
tar -czf - -C "${BACKUP_DIR}" control_plane.db domains_dkim_inventory.csv stalwart-data.tar.gz \
  | gpg --symmetric --cipher-algo AES256 -o "${BACKUP_DIR}/ka-posong-bundle.tar.gz.gpg"
chmod 600 "${BACKUP_DIR}"/*
```

### 4.3 Restore Verification Procedure (Monthly & Pre-Release Gate)
A backup is unverified until restored and tested in an isolated environment:

1. **Decrypt and extract** the backup bundle into a temporary verification directory (`/tmp/kaposong-restore-verify-$$`).
2. **Verify SQLite schema & tenant counts**:
   ```bash
   sqlite3 /tmp/kaposong-restore-verify-$$/control_plane.db \
     "PRAGMA integrity_check; SELECT COUNT(*) AS tenants FROM tenants; SELECT COUNT(*) AS mailboxes FROM mailboxes;"
   ```
3. **Verify DKIM key continuity**: Confirm every active domain in `domains` has a non-placeholder `dkim_public_key` (`v=DKIM1; k=ed25519; p=...`) and matching private key material inside the restored `stalwart-data.tar.gz` archive.
4. **Boot isolated verification instance**: Run `rust-control-plane` on an ephemeral loopback port against the restored SQLite file (`DATABASE_URL=sqlite:///tmp/kaposong-restore-verify-$$/control_plane.db`) and confirm `GET /api/health` returns `"status": "ok"` with expected `tenants_count` and `mailboxes_count`.
5. **Clean up** the temporary verification directory and record the restore test timestamp, operator, and backup ID in the production change log.
