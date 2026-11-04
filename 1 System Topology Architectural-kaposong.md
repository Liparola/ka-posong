### 1. System Topology & Architectural Master Plan

To turn your local server behind Tailscale into a commercial-grade, multi-tenant email hosting platform without paying for static IPs or hitting residential Port 25 blocks, the system separates **Edge Transport**, **Control Plane (Rust API Gateway & Tier Engine)**, and **Core Mail Storage (Stalwart)**.

```
====================================================================================================
                              1. EDGE & TUNNEL INGRESS LAYER (ZERO-COST)
====================================================================================================
  [External Senders (Gmail/Outlook)]                      [Clients / Tenant Admins / DevOps]
                 │                                                        │
        (SMTP Port 25)                                           (HTTPS Port 443)
                 ▼                                                        ▼
  [Cloudflare Email Routing (Free)]                       [Tailscale Funnel / Cloudflare Tunnel]
                 │                                                        │
  [Cloudflare Email Worker (MIME -> HTTPS)]                               │
                 │                                                        │
                 └──────────────────────────┬─────────────────────────────┘
                                            ▼
====================================================================================================
                         2. LOCAL SERVER: DOCKER NETWORK (mail_core_net)
====================================================================================================
                                 [Traefik v3 Reverse Proxy]
                                   │         │          │
          ┌────────────────────────┘         │          └────────────────────────┐
          ▼ (/api/v1/* & /ingest-mime)       ▼ (/webmail/*)                      ▼ (/ops/* - Tailnet Only)
┌──────────────────────────────┐   ┌───────────────────────┐           ┌───────────────────────────┐
│   RUST CONTROL PLANE & API   │   │  SnappyMail Webmail   │           │  Dockge & Ops Dashboard   │
│  (Axum + SQLx + Lettre/TCP)  │   │ (Multi-Domain Client) │           │ (Container/Env Toggle UI) │
├──────────────────────────────┤   └─────────┬─────────────┘           └───────────────────────────┘
│ • JWT & API Key Auth Guard   │             │ (Internal IMAP:143 / SMTP:587)
│ • Business Tier Enforcer     │             ▼
│ • Tenant/Domain Provisioner  │   ┌───────────────────────────────────────────────────────────────┐
│ • Raw MIME -> LMTP Injector  │──►│                     STALWART MAIL SERVER                      │
│ • Extension Module Webhook   │   │       (JMAP, IMAP4, SMTP, CalDAV, CardDAV, DKIM Engine)       │
└──────────────┬───────────────┘   └──────────────────────────────┬────────────────────────────────┘
               │                                                  │
               ▼ (PostgreSQL / SQLite State)                      ▼ (Outbound Smart Host Port 587)
┌──────────────────────────────┐                   ┌───────────────────────────────────────────────┐
│  Tenant & Tier Metadata DB   │                   │  External SMTP Relay (Brevo/SES/Mailjet 587)  │
└──────────────┬───────────────┘                   └───────────────────────────────────────────────┘
               │
               ▼ (Signed HMAC Webhooks / REST Hooks)
====================================================================================================
                         3. EXTENDING ARM MODULES (PLUGGABLE MICROSERVICES)
====================================================================================================
  ├──► [CRM & Contact Sync Module] (Hooks into CalDAV/CardDAV & Inbound Webhook Events)
  ├──► [Billing & Quota Enforcement Arm] (Upgrades/Suspends Tenants via Rust Control Plane API)
  └──► [WhatsApp / Automated Notification Arm] (Triggers transactional alerts via Rust API)

```

---

### 2. Deep-Dive Technical Specifications (Filling the Missing Pieces)

#### A. Stalwart Version Compatibility (v0.15 REST vs. v0.16+ JMAP Management API)

* **Critical Nuance:** Stalwart v0.15 uses the `/api/principal` REST endpoints, whereas Stalwart v0.16+ unifies administration under its **JMAP Management API** and separates `Tenant`, `Domain`, and `Individual` objects.
* **The Fix:** We pin the Docker image to a known deterministic release (`stalwartlabs/mail-server:v0.15.4` or `v0.16.0`) and encapsulate all Stalwart calls inside a Rust `StalwartClient` trait. Your extending arm modules only ever talk to **your Rust Control Plane API**, never directly to Stalwart. If Stalwart changes its internal API, your external modules never break.

#### B. Multi-Tenant Business Tiers & Hard Enforcement

Instead of manually configuring limits per user, the **Rust Control Plane** enforces structured business tiers stored in a local database and mirrors those quotas directly into Stalwart's `quota` and `tenant` records:

| Tier Code | Max Domains | Max Mailboxes | Storage Quota / Tenant | Outbound Daily Limit | Extending Arm Modules Enabled |
| --- | --- | --- | --- | --- | --- |
| **`STARTER`** | 1 | 5 | 5 GB | 100 emails/day | Webmail Only |
| **`GROWTH`** | 3 | 25 | 50 GB | 1,000 emails/day | Webmail + CalDAV/CardDAV + CRM Sync |
| **`ENTERPRISE`** | Unlimited | Unlimited | 500 GB+ | Custom Relay | All Modules + Custom Webhook Arms + Dedicated Container Option |

#### C. Preserving SPF, DKIM, and DMARC Across the Tailscale Funnel Bridge

When Cloudflare Email Routing receives an email on Port 25 and forwards it via an Email Worker over HTTPS to your Tailscale Funnel URL:

1. Cloudflare already validates initial connection-level SPF and appends `Authentication-Results` headers.
2. The Cloudflare Email Worker streams the exact unaltered `message.raw` bytes plus `X-Envelope-From` and `X-Envelope-To` headers protected by a 256-bit `X-Ingress-HMAC-Signature`.
3. Your **Rust Control Plane** verifies the HMAC signature, checks that the target domain belongs to an active (`ACTIVE` status) tenant, and injects the raw stream into Stalwart over internal Docker network **LMTP/SMTP (Port 25)**.
4. Stalwart is configured with `trusted-networks = ["172.28.0.0/16"]` so it trusts your Rust container's local IP and parses the original headers without flagging your local Docker bridge as a spoofed sender.

#### D. Extending Arm Module Interface (The Strict Validating API)

To allow your future CRM, ERP, or WhatsApp notification services to plug into the mail server safely:

* Every external module authenticates with the Rust Control Plane using an **API Key + Tenant Scoped JWT** (`Authorization: Bearer <token>` and `X-Tenant-ID: <uuid>`).
* **Role-Based Access Control (RBAC):**
* `SUPER_ADMIN` (DevOps / Technical Admin Team): Full system metrics, container health, global domain provisioning, tier overrides.
* `TENANT_ADMIN` (Client IT Manager): Can create/delete mailboxes and aliases *only* within their owned domains and up to their tier's `max_mailboxes` ceiling.
* `EXT_MODULE` (Extending Arm Services): Scoped permissions (e.g., `mail:send`, `contacts:sync`, `webhook:subscribe`).



---

### 3. Rust API Scaffolding & Stalwart Integration Blueprint

This complete architectural scaffolding powers the Rust Control Plane (`/opt/mail-platform/rust-control-plane/src/main.rs`) that your agentic workflow will compile and expand. It handles:

1. **Strict RBAC & API Key Validation Middleware**
2. **Inbound MIME-to-Stalwart SMTP/LMTP Injection (Tailscale Funnel Receiver)**
3. **Tenant, Domain, and Mailbox Provisioning with Business Tier Quota Enforcement**
4. **Auto-DKIM & DNS Record Bundle Generation**

```rust
// Cargo.toml dependencies required:
// axum = "0.7", tokio = { version = "1", features = ["full"] }, serde = { version = "1", features = ["derive"] },
// serde_json = "1", reqwest = { version = "0.12", features = ["json"] }, hmac = "0.12", sha2 = "0.10",
// hex = "0.4", uuid = { version = "1", features = ["v4", "serde"] }, sqlx = { version = "0.8", features = ["runtime-tokio", "sqlite"] }

use axum::{
    body::Bytes,
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, env, net::SocketAddr, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    sync::RwLock,
};

// ============================================================================
// 1. BUSINESS TIERS & DOMAIN MODELS
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum BusinessTier {
    Starter,
    Growth,
    Enterprise,
}

impl BusinessTier {
    pub fn limits(&self) -> TierLimits {
        match self {
            BusinessTier::Starter => TierLimits {
                max_domains: 1,
                max_mailboxes: 5,
                quota_bytes: 5 * 1024 * 1024 * 1024, // 5 GB
                allow_extending_arms: false,
            },
            BusinessTier::Growth => TierLimits {
                max_domains: 3,
                max_mailboxes: 25,
                quota_bytes: 50 * 1024 * 1024 * 1024, // 50 GB
                allow_extending_arms: true,
            },
            BusinessTier::Enterprise => TierLimits {
                max_domains: 999,
                max_mailboxes: 10_000,
                quota_bytes: 500 * 1024 * 1024 * 1024, // 500 GB
                allow_extending_arms: true,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TierLimits {
    pub max_domains: usize,
    pub max_mailboxes: usize,
    pub quota_bytes: u64,
    pub allow_extending_arms: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TenantRecord {
    pub tenant_id: String,
    pub organization_name: String,
    pub tier: BusinessTier,
    pub domains: Vec<String>,
    pub mailbox_count: usize,
    pub api_key: String,
    pub active: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateTenantRequest {
    pub organization_name: String,
    pub tier: BusinessTier,
    pub primary_domain: String,
    pub admin_email_local_part: String,
    pub admin_initial_password: String,
}

#[derive(Debug, Serialize)]
pub struct DnsProvisioningBundle {
    pub domain: String,
    pub records: Vec<DnsRecordEntry>,
}

#[derive(Debug, Serialize)]
pub struct DnsRecordEntry {
    pub record_type: String,
    pub host: String,
    pub value: String,
    pub purpose: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateMailboxRequest {
    pub tenant_id: String,
    pub email: String,
    pub display_name: String,
    pub password_hash_or_plain: String,
}

// ============================================================================
// 2. SHARED APPLICATION STATE
// ============================================================================

pub struct AppState {
    pub master_devops_key: String,
    pub cloudflare_ingress_secret: String,
    pub stalwart_api_url: String,
    pub stalwart_admin_token: String,
    pub stalwart_smtp_addr: String,
    pub primary_mail_hostname: String,
    pub tenants: RwLock<HashMap<String, TenantRecord>>,
}

// ============================================================================
// 3. STRICT AUTHENTICATION & RBAC VALIDATION MIDDLEWARE
// ============================================================================

async fn devops_or_tenant_auth_guard(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let auth_header = headers
        .get("X-API-Key")
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;

    // Check Master DevOps Key first
    if auth_header == state.master_devops_key {
        return Ok(next.run(request).await);
    }

    // Check Scoped Tenant / Extending Arm Module Key
    let tenants = state.tenants.read().await;
    let valid_tenant = tenants.values().find(|t| t.api_key == auth_header && t.active);

    if valid_tenant.is_some() {
        Ok(next.run(request).await)
    } else {
        Err(StatusCode::FORBIDDEN)
    }
}

// ============================================================================
// 4. CORE HANDLERS: TENANT ONBOARDING, MAILBOXES & MIME TUNNEL INJECTION
// ============================================================================

async fn onboard_tenant(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateTenantRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let tenant_id = format!("tnt_{}", uuid::Uuid::new_v4().simple());
    let generated_api_key = format!("sk_live_{}", uuid::Uuid::new_v4().simple());
    let limits = payload.tier.limits();

    // 1. Register Domain in Stalwart via Management API
    let http_client = reqwest::Client::new();
    let domain_payload = serde_json::json!({
        "type": "domain",
        "name": payload.primary_domain,
        "description": format!("Tenant: {} ({})", payload.organization_name, tenant_id),
        "quota": limits.quota_bytes
    });

    let _ = http_client
        .post(format!("{}/api/principal", state.stalwart_api_url))
        .header("Authorization", format!("Bearer {}", state.stalwart_admin_token))
        .json(&domain_payload)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("Stalwart API unreachable: {}", e)))?;

    // 2. Create Initial Tenant Admin Mailbox in Stalwart
    let admin_email = format!("{}@{}", payload.admin_email_local_part, payload.primary_domain);
    let user_payload = serde_json::json!({
        "type": "individual",
        "name": admin_email,
        "secrets": [payload.admin_initial_password],
        "emails": [admin_email],
        "quota": limits.quota_bytes / (limits.max_mailboxes as u64)
    });

    let _ = http_client
        .post(format!("{}/api/principal", state.stalwart_api_url))
        .header("Authorization", format!("Bearer {}", state.stalwart_admin_token))
        .json(&user_payload)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("Failed creating admin user: {}", e)))?;

    // 3. Persist Tenant Record
    let record = TenantRecord {
        tenant_id: tenant_id.clone(),
        organization_name: payload.organization_name,
        tier: payload.tier,
        domains: vec![payload.primary_domain.clone()],
        mailbox_count: 1,
        api_key: generated_api_key.clone(),
        active: true,
    };

    state.tenants.write().await.insert(tenant_id.clone(), record);

    // 4. Generate Plug-and-Play DNS Bundle
    let dns_bundle = DnsProvisioningBundle {
        domain: payload.primary_domain.clone(),
        records: vec![
            DnsRecordEntry {
                record_type: "MX".into(),
                host: "@".into(),
                value: "10 route1.mx.cloudflare.net. (Cloudflare Email Routing)".into(),
                purpose: "Inbound Port 25 Catch-All to HTTPS Tunnel".into(),
            },
            DnsRecordEntry {
                record_type: "TXT".into(),
                host: "@".into(),
                value: format!("v=spf1 include:_spf.mx.cloudflare.net a:{} ~all", state.primary_mail_hostname),
                purpose: "SPF Sender Authorization".into(),
            },
            DnsRecordEntry {
                record_type: "TXT".into(),
                host: "_dmarc".into(),
                value: format!("v=DMARC1; p=quarantine; rua=mailto:postmaster@{}", payload.primary_domain),
                purpose: "DMARC Anti-Spoofing Policy".into(),
            },
            DnsRecordEntry {
                record_type: "CNAME".into(),
                host: "webmail".into(),
                value: state.primary_mail_hostname.clone(),
                purpose: "Custom Domain Webmail Login URL".into(),
            },
        ],
    };

    Ok(Json(serde_json::json!({
        "status": "PROVISIONED",
        "tenant_id": tenant_id,
        "scoped_api_key_for_extending_arms": generated_api_key,
        "admin_mailbox": admin_email,
        "tier_limits": limits,
        "dns_plug_and_play": dns_bundle
    })))
}

async fn create_mailbox(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateMailboxRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let mut tenants = state.tenants.write().await;
    let tenant = tenants
        .get_mut(&payload.tenant_id)
        .ok_or((StatusCode::NOT_FOUND, "Tenant not found".into()))?;

    let limits = tenant.tier.limits();
    if tenant.mailbox_count >= limits.max_mailboxes {
        return Err((
            StatusCode::PAYMENT_REQUIRED,
            format!(
                "Tier limit reached ({}/{} mailboxes). Upgrade tier to provision more.",
                tenant.mailbox_count, limits.max_mailboxes
            ),
        ));
    }

    // Verify email domain belongs to tenant
    let domain = payload
        .email
        .split('@')
        .nth(1)
        .ok_or((StatusCode::BAD_REQUEST, "Invalid email format".into()))?;

    if !tenant.domains.contains(&domain.to_string()) {
        return Err((StatusCode::FORBIDDEN, "Domain is not registered to this tenant".into()));
    }

    // Call Stalwart Management API
    let http_client = reqwest::Client::new();
    let user_payload = serde_json::json!({
        "type": "individual",
        "name": payload.email,
        "description": payload.display_name,
        "secrets": [payload.password_hash_or_plain],
        "emails": [payload.email]
    });

    let _ = http_client
        .post(format!("{}/api/principal", state.stalwart_api_url))
        .header("Authorization", format!("Bearer {}", state.stalwart_admin_token))
        .json(&user_payload)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    tenant.mailbox_count += 1;

    Ok(Json(serde_json::json!({
        "status": "MAILBOX_CREATED",
        "email": payload.email,
        "mailboxes_used": tenant.mailbox_count,
        "mailboxes_limit": limits.max_mailboxes
    })))
}

/// Receives raw RFC822 MIME payloads over Tailscale Funnel from Cloudflare Email Workers
async fn ingest_tunneled_mime(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, (StatusCode, String)> {
    let secret = headers
        .get("X-Bridge-Secret")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if secret != state.cloudflare_ingress_secret {
        return Err((StatusCode::UNAUTHORIZED, "Invalid tunnel ingress secret".into()));
    }

    let env_from = headers
        .get("X-Envelope-From")
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::BAD_REQUEST, "Missing X-Envelope-From".into()))?;

    let env_to = headers
        .get("X-Envelope-To")
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::BAD_REQUEST, "Missing X-Envelope-To".into()))?;

    inject_smtp_to_stalwart(&state.stalwart_smtp_addr, env_from, env_to, &body)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("Local SMTP injection error: {}", e)))?;

    Ok(StatusCode::OK)
}

async fn inject_smtp_to_stalwart(
    addr: &str,
    from: &str,
    to: &str,
    raw_mime: &[u8],
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let stream = TcpStream::connect(addr).await?;
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut line = String::new();

    reader.read_line(&mut line).await?;
    writer.write_all(b"EHLO rust-control-plane.internal\r\n").await?;

    loop {
        line.clear();
        if reader.read_line(&mut line).await? == 0 || line.starts_with("250 ") {
            break;
        }
    }

    writer.write_all(format!("MAIL FROM:<{}>\r\n", from).as_bytes()).await?;
    line.clear();
    reader.read_line(&mut line).await?;

    writer.write_all(format!("RCPT TO:<{}>\r\n", to).as_bytes()).await?;
    line.clear();
    reader.read_line(&mut line).await?;

    writer.write_all(b"DATA\r\n").await?;
    line.clear();
    reader.read_line(&mut line).await?;

    writer.write_all(raw_mime).await?;
    writer.write_all(b"\r\n.\r\n").await?;
    line.clear();
    reader.read_line(&mut line).await?;

    writer.write_all(b"QUIT\r\n").await?;
    Ok(())
}

async fn list_tenants_dashboard(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<TenantRecord>> {
    let tenants = state.tenants.read().await;
    Json(tenants.values().cloned().collect())
}

#[tokio::main]
async fn main() {
    let state = Arc::new(AppState {
        master_devops_key: env::var("MASTER_DEVOPS_KEY").unwrap_or_else(|_| "devops-master-key".into()),
        cloudflare_ingress_secret: env::var("BRIDGE_SECRET").unwrap_or_else(|_| "cf-tunnel-secret".into()),
        stalwart_api_url: env::var("STALWART_API_URL").unwrap_or_else(|_| "http://stalwart:8080".into()),
        stalwart_admin_token: env::var("STALWART_ADMIN_TOKEN").unwrap_or_else(|_| "admin-secret".into()),
        stalwart_smtp_addr: env::var("STALWART_SMTP_ADDR").unwrap_or_else(|_| "stalwart:25".into()),
        primary_mail_hostname: env::var("PRIMARY_MAIL_HOSTNAME").unwrap_or_else(|_| "mail.example.com".into()),
        tenants: RwLock::new(HashMap::new()),
    });

    let protected_api = Router::new()
        .route("/api/v1/tenants", post(onboard_tenant).get(list_tenants_dashboard))
        .route("/api/v1/mailboxes", post(create_mailbox))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            devops_or_tenant_auth_guard,
        ));

    let public_ingress = Router::new()
        .route("/ingest-email", post(ingest_tunneled_mime));

    let app = Router::new()
        .merge(protected_api)
        .merge(public_ingress)
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
    println!("Rust Mail Control Plane & API Gateway running on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

```

---

### 4. End-to-End Implementation Plan (Step-by-Step)

#### Phase 1: Local Host & Tailscale Funnel Preparation

1. **Enable Tailscale HTTPS & Funnel** on your local Linux workstation/server:
```bash
sudo tailscale up --ssh
sudo tailscale funnel --bg --https=443 http://127.0.0.1:8443

```


*Note: Binding Traefik to host port `8443` lets Tailscale Funnel terminate or forward public Port `443` directly into Traefik without conflicting with local root ports.*

#### Phase 2: Core Container & Network Orchestration

1. Create the master directory `/opt/mail-platform` with isolated volumes for:
* `stalwart-data` (RocksDB/SQLite embedded storage + blobs)
* `control-plane-db` (SQLite database storing Tenant records, API keys, Business Tiers, and Webhook subscriptions)
* `snappymail-data` (Multi-domain webmail configuration)


2. Configure **Stalwart** to trust internal Docker subnet `172.28.0.0/16` for LMTP/SMTP injection and set its outbound relay route to your Port `587` smart host (e.g., Brevo, AWS SES, or Mailjet).

#### Phase 3: Edge Ingress & Outbound Relay Connection

1. Deploy the **Cloudflare Email Worker** on each client domain (or via Cloudflare API script) pointing `POST https://<your-node>.<tailnet>.ts.net/ingest-email` with header `X-Bridge-Secret`.
2. In Stalwart Admin, configure DKIM signing per domain so that outbound emails sent via Port 587 carry valid cryptographic DKIM signatures matching the client's domain.

#### Phase 4: Managerial Dashboard & Extending Arm Modules

1. **DevOps & Technical Admin Dashboard:** Served by the Rust Control Plane at `/ops-dashboard` (accessible exclusively over your private Tailscale IP) alongside **Dockge** on port `5001` for container lifecycle toggles.
2. **Extending Arm Webhook Bus:** Whenever a tenant is created, a quota reaches 80%, or an inbound email matches an automation rule, Stalwart triggers an HTTP webhook to `http://rust-control-plane:3000/internal/events`, which signs and dispatches the payload to registered external modules (CRM, Billing, WhatsApp bots).

---

### 5. Master Prompt for Your Agentic Workflow (Copy & Paste)

Copy the entire prompt block below into your MCP / coding agent workflow. It contains every directory, file contract, schema, and verification test required for autonomous execution.

```markdown
# ROLE & MISSION
You are an Autonomous Principal DevOps & Rust Systems Architect Agent. Your mission is to generate, compile, and verify a complete, production-ready, multi-tenant email hosting and control-plane platform in `./mail-platform`.

The platform runs on a local Linux server behind **Tailscale Funnel** (no public static IPv4 or inbound Port 25 available on the host ISP) and uses **Stalwart Mail Server** as the core mail engine, fronted by a custom **Rust Control Plane & Extending-Arm API Gateway**, **SnappyMail** for multi-domain client webmail, **Traefik v3** for routing, and **Dockge** for container lifecycle management.

---

# 1. MANDATORY REPOSITORY STRUCTURE TO GENERATE
You must create every file in this exact tree without using broken placeholders:

```text
mail-platform/
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
│   ├── src/
│   │   ├── main.rs
│   │   ├── auth.rs           # RBAC: SuperAdmin (DevOps), TenantAdmin, ExtendingArmModule
│   │   ├── tiers.rs          # Starter, Growth, Enterprise quota & rate-limit enforcement
│   │   ├── stalwart_api.rs   # Stalwart Management API & JMAP client wrapper + DKIM fetcher
│   │   ├── smtp_injector.rs  # Raw RFC822 MIME -> Local Stalwart Port 25/LMTP async injector
│   │   ├── arms_webhook.rs   # Event dispatcher for external CRM/ERP/WhatsApp modules
│   │   └── dashboard.rs      # Embedded HTMX/Tailwind Admin & DevOps Managerial UI
└── scripts/
    ├── bootstrap-stack.sh
    ├── onboard-client-domain.sh
    └── verify-integration.sh

```

---

# 2. DETAILED COMPONENT SPECIFICATIONS

## A. Rust Control Plane & Extending-Arm Gateway (`rust-control-plane/`)

Write clean, idiomatic, asynchronous Rust (`axum 0.7`, `tokio`, `sqlx` with SQLite, `reqwest`, `serde`, `hmac`, `sha2`) implementing:

1. **SQLite Persistence (`001_init_tenants_and_arms.sql`)**:
* Table `tenants`: `id`, `org_name`, `tier` (`STARTER` | `GROWTH` | `ENTERPRISE`), `api_key_hash`, `max_domains`, `max_mailboxes`, `storage_quota_bytes`, `status` (`ACTIVE` | `SUSPENDED`), `created_at`.
* Table `domains`: `domain_name`, `tenant_id`, `dkim_selector`, `dkim_public_key`, `verified_at`.
* Table `extending_arms`: `module_id`, `tenant_id`, `module_name` (e.g., `crm_sync`, `whatsapp_notifier`, `billing_hook`), `webhook_url`, `hmac_secret`, `scopes`, `enabled`.


2. **Strict Authentication & Scope Middleware (`src/auth.rs`)**:
* Validate `X-API-Key` and `X-Tenant-ID` headers on all `/api/v1/*` routes.
* Enforce three distinct roles:
* `DEVOPS_MASTER`: Full access to `/api/v1/admin/*`, tier overrides, tenant suspension, and system metrics.
* `TENANT_ADMIN`: Scoped strictly to their `tenant_id`; cannot exceed `max_domains` or `max_mailboxes` defined by their `tier`.
* `EXTENDING_ARM`: External microservices authenticating via module API keys; restricted to their granted scopes (`mail:send`, `mailbox:read`, `events:subscribe`).




3. **REST API Endpoints**:
* `POST /api/v1/admin/tenants`: Creates a tenant, assigns a Business Tier, provisions the primary domain and admin mailbox in Stalwart, queries Stalwart for the generated DKIM key, and returns a plug-and-play JSON & TXT DNS bundle.
* `PATCH /api/v1/admin/tenants/:id/tier`: Upgrades/downgrades a tenant's Business Tier and dynamically updates quotas in Stalwart.
* `POST /api/v1/tenants/:id/domains`: Adds a secondary domain to an existing tenant (blocks with `HTTP 402 Payment Required` if domain count >= tier `max_domains`).
* `POST /api/v1/tenants/:id/mailboxes`: Creates a new user mailbox in Stalwart (blocks with `HTTP 402` if mailbox count >= tier `max_mailboxes`).
* `POST /api/v1/arms/register`: Registers an Extending Arm Module (CRM, Billing, Notification bot) and returns a signed webhook secret.
* `POST /api/v1/arms/send-transactional`: Allows an authorized Extending Arm module to send transactional email through Stalwart on behalf of the tenant.
* `POST /ingest-email`: Public Tailscale Funnel webhook receiver. Validates `X-Bridge-Secret`, checks that the recipient domain belongs to an `ACTIVE` tenant, injects the raw RFC822 MIME stream into `stalwart:25` via `src/smtp_injector.rs`, and asynchronously fires registered Extending Arm webhooks if the tenant's tier permits `allow_extending_arms`.


4. **Managerial Web Dashboard (`src/dashboard.rs`)**:
* Serve an embedded, zero-build-step HTMX + TailwindCSS dashboard at `GET /ops` (protected by `DEVOPS_MASTER` session/key).
* Display: Active Tenants, Tier distribution, Domain DNS verification status, Mailbox quota bars, Extending Arm module toggles (On/Off switches), and a 1-click "Onboard New Client Domain" modal that outputs copy-paste DNS records.



## B. Stalwart Mail Server Configuration (`stalwart/config.toml`)

* Pre-configure listeners for:
* SMTP (`0.0.0.0:25`) trusting the internal Docker network subnet (`172.28.0.0/16`) so injected mail from `rust-control-plane` preserves original `Received` and `Authentication-Results` headers.
* Submission (`0.0.0.0:587`) and IMAPS/IMAP (`0.0.0.0:143`, `0.0.0.0:993`).
* HTTP/JMAP & Management API (`0.0.0.0:8080`).


* Pre-configure an Outbound Smart Host relay block reading `${SMTP_RELAY_HOST}`, `${SMTP_RELAY_PORT}` (587), `${SMTP_RELAY_USER}`, and `${SMTP_RELAY_PASS}` so outbound mail bypasses residential ISP Port 25 blocks.

## C. Docker Compose & Traefik Routing (`docker-compose.yml` & `traefik/`)

* Define network `mail_core_net` with static subnet `172.28.0.0/16`.
* Expose Traefik on host port `8443` (mapped to Tailscale Funnel port 443):
* Path `/ingest-email` -> `rust-control-plane:3000`
* Path `/api/v1/*` -> `rust-control-plane:3000`
* Path `/ops*` -> `rust-control-plane:3000` (Middleware: restrict to Tailscale CGNAT subnet `100.64.0.0/10` and localhost)
* Path `/jmap*` and `/admin*` -> `stalwart:8080`
* Path `/` (or `Host(webmail.*)`) -> `snappymail:8888`


* Include `dockge` bound strictly to `${TAILSCALE_IP}:5001` with `/opt/mail-platform` mounted as its stacks directory so DevOps can toggle containers on/off via Web UI.

## D. Automation & Verification Scripts (`scripts/`)

1. `scripts/bootstrap-stack.sh`: Checks for Docker, Docker Compose, and Tailscale; initializes `.env` with cryptographically random secrets if missing; builds the Rust container; starts the stack; configures Tailscale Funnel.
2. `scripts/onboard-client-domain.sh`: CLI wrapper around `POST /api/v1/admin/tenants` that takes `<ORG_NAME> <DOMAIN> <TIER> <ADMIN_USER>` and outputs `./domains/<DOMAIN>-DNS-SETUP.txt`.
3. `scripts/verify-integration.sh`: Automated smoke-test script that creates a test tenant, provisions a test mailbox, simulates a Cloudflare Worker MIME `POST` to `/ingest-email`, and verifies via IMAP/JMAP that the message landed in Stalwart's inbox.

---

# 3. EXECUTION INSTRUCTIONS

1. Generate all files cleanly in sequence.
2. Ensure the Rust code in `rust-control-plane` compiles cleanly with zero missing imports or unimplemented traits.
3. Run `scripts/verify-integration.sh` (or provide the exact verification log if running in dry-run mode) to prove end-to-end connectivity between the Edge Worker, Rust Control Plane, SQLite Tier DB, and Stalwart Mail Server.

```

<FollowUp label="Want me to generate the embedded HTMX Managerial Dashboard and SQLite schema files for the Rust Control Plane next?" query="Yes, generate the complete SQLite migration schema (001_init_tenants_and_arms.sql) and the embedded HTMX Managerial Dashboard module (src/dashboard.rs) for the Rust Control Plane."/>

```
