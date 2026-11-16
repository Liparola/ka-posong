// ============================================================================
// KA-POSONG UMANG CORE TENANT PLATFORM CONNECTOR & AUTH ENGINE (src/umang_auth.rs)
// Connects ka-posong to the consolidated UMANG Core Platform (`tnt_ka_posong`,
// L3_EXTENDING_ARMS / ENTERPRISE) via `/api/v1/instances/:tenantId/auth/*`,
// OIDC/OAuth2 SSO (`/api/v1/sso/*`), and HMAC-SHA256 Extending Arms webhooks.
// ============================================================================

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{Query, Request, State},
    http::{HeaderMap, StatusCode},
    response::{Json, Response},
};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::{collections::HashMap, env, sync::Arc};

use crate::{
    auth::{
        compute_hmac_hex, constant_time_eq, revoke_jti, revoke_token, sign_umang_jwt,
        UmangJwtClaims,
    },
    AppState,
};

#[derive(Debug, Clone)]
pub struct CachedOtpEntry {
    pub otp: String,
    pub issued_at: i64,
    pub expires_at: i64,
    pub email: String,
    pub tenant_id: String,
    pub domain: String,
    pub attempts: u32,
    pub window_start: i64,
    pub window_count: u32,
    pub delegated_to_umang_core: bool,
}

#[derive(Debug, Deserialize)]
pub struct RequestOtpPayload {
    pub phone: String,
    pub domain: Option<String>,
    pub channel: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct VerifyOtpPayload {
    pub phone: String,
    #[serde(alias = "code")]
    pub otp: String,
    pub domain: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SsoExchangePayload {
    pub code: String,
    pub code_verifier: Option<String>,
    pub redirect_uri: Option<String>,
    pub domain: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LogoutPayload {
    pub token: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UmangClientInfo {
    pub phone: String,
    pub email: String,
    #[serde(rename = "clientId")]
    pub client_id: String,
    #[serde(rename = "umangTenantId")]
    pub umang_tenant_id: String,
    pub name: String,
    pub domain: String,
    pub role: String,
    pub access: String,
    pub subscription: String,
    #[serde(rename = "planId")]
    pub plan_id: String,
    pub subscribed_to_whatsapp_otp: bool,
    pub status: String,
}

pub fn normalize_lesotho_phone(raw: &str) -> Option<String> {
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() == 8
        && (digits.starts_with('5') || digits.starts_with('6') || digits.starts_with('2'))
    {
        return Some(format!("+266{}", digits));
    }
    if digits.len() == 11 && digits.starts_with("266") {
        return Some(format!("+{}", digits));
    }
    if digits.len() == 9 && digits.starts_with('0') {
        return Some(format!("+266{}", &digits[1..]));
    }
    if digits.len() >= 10 {
        return Some(format!("+{}", digits));
    }
    None
}

/// Masks an email address for unauthenticated OTP confirmation responses (e.g. `in***@karabomilling.co.ls`)
pub fn mask_email_hint(email: &str) -> String {
    if let Some((local, domain)) = email.split_once('@') {
        let chars: Vec<char> = local.chars().collect();
        if chars.len() <= 2 {
            let first = chars.first().copied().unwrap_or('*');
            format!("{}***@{}", first, domain)
        } else {
            let prefix: String = chars.into_iter().take(2).collect();
            format!("{}***@{}", prefix, domain)
        }
    } else {
        "***".to_string()
    }
}

pub fn resolve_public_umang_base_url(headers: &HeaderMap, state: &AppState) -> String {
    if let Ok(explicit) = env::var("PUBLIC_UMANG_URL") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return trimmed.trim_end_matches('/').to_string();
        }
    }

    let host = headers
        .get("X-Forwarded-Host")
        .or_else(|| headers.get("Host"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim();

    if !host.is_empty() && !host.starts_with("127.0.0.1") && !host.starts_with("localhost") {
        let proto = headers
            .get("X-Forwarded-Proto")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("https");
        return format!("{}://{}", proto, host);
    }

    state.umang_core_url.trim_end_matches('/').to_string()
}

/// Transparently proxies public UMANG OIDC/SSO/SDK browser routes through ka-posong Gateway
pub async fn umang_sso_proxy_handler(
    State(state): State<Arc<AppState>>,
    req: Request,
) -> Result<Response, (StatusCode, Json<serde_json::Value>)> {
    let path = req.uri().path().to_string();
    let is_allowed_path = path == "/.well-known/openid-configuration"
        || path == "/.well-known/jwks.json"
        || path == "/sdk/v1/umang.js"
        || path == "/sso/authorize"
        || path.starts_with("/api/v1/sso/")
        || (path.starts_with("/api/v1/instances/")
            && (path.contains("/auth/") || path.ends_with("/.well-known/openid-configuration")));

    if !is_allowed_path || path.contains("..") {
        return Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Not Found" })),
        ));
    }

    let query_part = req
        .uri()
        .query()
        .map(|q| format!("?{}", q))
        .unwrap_or_default();
    let target_url = format!(
        "{}{}{}",
        state.umang_core_url.trim_end_matches('/'),
        path,
        query_part
    );

    let method_str = req.method().as_str().to_string();
    let req_method = reqwest::Method::from_bytes(method_str.as_bytes()).unwrap_or(reqwest::Method::GET);

    let incoming_headers = req.headers().clone();
    let body_bytes = to_bytes(req.into_body(), 2 * 1024 * 1024)
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": format!("Invalid request body: {}", e) })),
            )
        })?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let mut proxy_req = client.request(req_method, &target_url).body(body_bytes);

    for header_name in [
        "content-type",
        "authorization",
        "x-api-key",
        "x-tenant-id",
        "x-umang-client-id",
        "accept",
    ] {
        if let Some(val) = incoming_headers.get(header_name).and_then(|v| v.to_str().ok()) {
            proxy_req = proxy_req.header(header_name, val);
        }
    }

    if let Some(host_val) = incoming_headers
        .get("x-forwarded-host")
        .or_else(|| incoming_headers.get("host"))
        .and_then(|v| v.to_str().ok())
    {
        proxy_req = proxy_req.header("Host", host_val);
        let proto = incoming_headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .unwrap_or(if host_val.starts_with("127.0.0.1") || host_val.starts_with("localhost") {
                "http"
            } else {
                "https"
            });
        proxy_req = proxy_req.header("X-Forwarded-Proto", proto);
    }

    let upstream = proxy_req.send().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "error": format!("UMANG Core Engine unavailable: {}", e) })),
        )
    })?;

    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json; charset=utf-8")
        .to_string();
    let cache_ctrl = upstream
        .headers()
        .get("cache-control")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let resp_bytes = upstream.bytes().await.unwrap_or_default();

    let mut builder = Response::builder()
        .status(status)
        .header("Content-Type", content_type);
    if let Some(cc) = cache_ctrl {
        builder = builder.header("Cache-Control", cc);
    }

    Ok(builder.body(Body::from(resp_bytes)).unwrap_or_else(|_| Response::new(Body::empty())))
}

/// Asynchronously synchronizes a ka-posong domain into UMANG Core (`tnt_ka_posong`)
pub async fn sync_domain_to_umang_core(state: &AppState, domain: &str) {
    let url = format!(
        "{}/api/v1/tenants/{}/domains",
        state.umang_core_url.trim_end_matches('/'),
        state.umang_tenant_id
    );
    let _ = reqwest::Client::new()
        .post(&url)
        .timeout(std::time::Duration::from_secs(4))
        .header("X-API-Key", &state.umang_api_key)
        .header("X-Tenant-ID", &state.umang_tenant_id)
        .json(&serde_json::json!({
            "domain": domain,
            "app_path": "/umail"
        }))
        .send()
        .await;
}

/// Asynchronously synchronizes a ka-posong mailbox identity into UMANG Core (`tnt_ka_posong`)
pub async fn sync_mailbox_to_umang_core(
    state: &AppState,
    email: &str,
    phone: &str,
    display_name: &str,
    domain: &str,
    role: &str,
    wa_enabled: bool,
) {
    let url = format!(
        "{}/api/v1/instances/{}/users",
        state.umang_core_url.trim_end_matches('/'),
        state.umang_tenant_id
    );
    let _ = reqwest::Client::new()
        .post(&url)
        .timeout(std::time::Duration::from_secs(4))
        .header("X-API-Key", &state.umang_api_key)
        .header("X-Tenant-ID", &state.umang_tenant_id)
        .json(&serde_json::json!({
            "phone": phone,
            "email": email,
            "display_name": display_name,
            "domain": domain,
            "role": role,
            "access": "full",
            "subscription": "enterprise",
            "planId": "plan_enterprise",
            "whatsapp_otp_enabled": wa_enabled
        }))
        .send()
        .await;
}

/// Asynchronously removes a deleted ka-posong mailbox from UMANG Core (`tnt_ka_posong`)
pub async fn delete_mailbox_from_umang_core(state: &AppState, email: &str) {
    let url = format!(
        "{}/api/v1/instances/{}/users/{}",
        state.umang_core_url.trim_end_matches('/'),
        state.umang_tenant_id,
        email
    );
    let _ = reqwest::Client::new()
        .delete(&url)
        .timeout(std::time::Duration::from_secs(4))
        .header("X-API-Key", &state.umang_api_key)
        .header("X-Tenant-ID", &state.umang_tenant_id)
        .send()
        .await;
}

/// Synchronizes all active ka-posong domains & mailboxes to UMANG Core on boot
pub async fn sync_all_identities_to_umang_core(state: Arc<AppState>) {
    if let Ok(domains) = sqlx::query("SELECT domain_name FROM domains")
        .fetch_all(&state.db)
        .await
    {
        for d in domains {
            let dom: String = d.get("domain_name");
            sync_domain_to_umang_core(&state, &dom).await;
        }
    }

    if let Ok(mailboxes) = sqlx::query(
        "SELECT email, phone, display_name, domain_name, role, whatsapp_otp_enabled FROM mailboxes WHERE status = 'ACTIVE'",
    )
    .fetch_all(&state.db)
    .await
    {
        for m in mailboxes {
            let email: String = m.get("email");
            let phone: String = m.get("phone");
            let name: String = m.get("display_name");
            let dom: String = m.get("domain_name");
            let role: String = m.get("role");
            let wa: i64 = m.get("whatsapp_otp_enabled");
            sync_mailbox_to_umang_core(&state, &email, &phone, &name, &dom, &role, wa == 1).await;
        }
    }
}

/// GET /api/auth/umang-config
/// Returns public, non-sensitive UMANG Core SSO configuration for the active client domain
pub async fn umang_config_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let domain = params
        .get("domain")
        .map(|d| d.trim().to_lowercase())
        .unwrap_or_else(|| "liparola.org".to_string());

    let public_base = resolve_public_umang_base_url(&headers, &state);

    Json(serde_json::json!({
        "status": "OK",
        "umang_standard": "UMANG-SSO-AetherWA-SMS-v2",
        "umang_tenant_id": state.umang_tenant_id,
        "umang_client_id": state.umang_client_id,
        "integration_level": "L3_EXTENDING_ARMS",
        "domain": domain,
        "sso_authorize_url": format!(
            "{}/sso/authorize?client_id={}&domain={}",
            public_base,
            state.umang_client_id,
            domain
        ),
        "oidc_discovery_url": format!(
            "{}/api/v1/instances/{}/.well-known/openid-configuration",
            public_base,
            state.umang_tenant_id
        ),
        "sdk_script_url": format!("{}/sdk/v1/umang.js", public_base)
    }))
}

/// POST /api/auth/request-otp
pub async fn request_otp_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RequestOtpPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let phone = normalize_lesotho_phone(&payload.phone).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Invalid Lesotho phone number format. Expected +266######## or 8 digits."
            })),
        )
    })?;

    // Look up active mailbox & tenant bound to this phone number
    let row = if let Some(ref dom) = payload.domain {
        sqlx::query(
            r#"SELECT m.email, m.tenant_id, m.domain_name, m.display_name, m.role, m.whatsapp_otp_enabled, m.status AS mbx_status,
                      t.status AS tnt_status, t.tier
               FROM mailboxes m
               JOIN tenants t ON t.id = m.tenant_id
               WHERE m.phone = ? AND m.domain_name = ?"#,
        )
        .bind(&phone)
        .bind(dom.trim().to_lowercase())
        .fetch_optional(&state.db)
        .await
    } else {
        sqlx::query(
            r#"SELECT m.email, m.tenant_id, m.domain_name, m.display_name, m.role, m.whatsapp_otp_enabled, m.status AS mbx_status,
                      t.status AS tnt_status, t.tier
               FROM mailboxes m
               JOIN tenants t ON t.id = m.tenant_id
               WHERE m.phone = ?
               ORDER BY m.created_at ASC LIMIT 1"#,
        )
        .bind(&phone)
        .fetch_optional(&state.db)
        .await
    }
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
    })?;

    let row = row.ok_or_else(|| {
        (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "No provisioned uMail inbox is bound to this phone number for this domain. Contact your organization administrator."
            })),
        )
    })?;

    let mbx_status: String = row.get("mbx_status");
    let tnt_status: String = row.get("tnt_status");
    if mbx_status != "ACTIVE" || tnt_status != "ACTIVE" {
        return Err((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "Mailbox or parent organization subscription is currently suspended."
            })),
        ));
    }

    let email: String = row.get("email");
    let tenant_id: String = row.get("tenant_id");
    let domain_name: String = row.get("domain_name");
    let display_name: String = row.get("display_name");
    let role: String = row.get("role");
    let wa_enabled: i64 = row.get("whatsapp_otp_enabled");

    let now = chrono::Utc::now().timestamp();

    // Compute per-phone rate-limit window state and enforce in production mode
    let (window_start, window_count) = {
        let cache = state.otp_cache.read().await;
        if let Some(existing) = cache.get(&phone) {
            if !state.allow_dev_otp_preview && now - existing.issued_at < 3 {
                return Err((
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(serde_json::json!({
                        "error": "Please wait a few seconds before requesting another verification code."
                    })),
                ));
            }
            if now - existing.window_start < 300 {
                if !state.allow_dev_otp_preview && existing.window_count >= 5 {
                    return Err((
                        StatusCode::TOO_MANY_REQUESTS,
                        Json(serde_json::json!({
                            "error": "Too many verification code requests for this number. Please try again in a few minutes."
                        })),
                    ));
                }
                (existing.window_start, existing.window_count + 1)
            } else {
                (now, 1)
            }
        } else {
            (now, 1)
        }
    };

    let preferred_channel = payload.channel.unwrap_or_else(|| {
        if wa_enabled == 1 {
            "whatsapp".to_string()
        } else {
            "sms".to_string()
        }
    });

    // Ensure the identity is synced in UMANG Core's `tnt_ka_posong` instance
    sync_mailbox_to_umang_core(
        &state,
        &email,
        &phone,
        &display_name,
        &domain_name,
        &role,
        wa_enabled == 1,
    )
    .await;

    // 1. Primary Path: Delegate OTP Generation, Vaulting & Delivery to UMANG Core Tenant Instance (`tnt_ka_posong`)
    let umang_instance_url = format!(
        "{}/api/v1/instances/{}/auth/request-otp",
        state.umang_core_url.trim_end_matches('/'),
        state.umang_tenant_id
    );

    let mut delegated_to_umang_core = false;
    let mut delivery_mode = "umang-core-platform".to_string();
    let mut fallback_otp = String::new();

    let client = reqwest::Client::new();
    match client
        .post(&umang_instance_url)
        .timeout(std::time::Duration::from_secs(10))
        .header("X-API-Key", &state.umang_api_key)
        .header("X-Tenant-ID", &state.umang_tenant_id)
        .header("X-Umang-Client-Id", &state.umang_client_id)
        .json(&serde_json::json!({
            "phone": phone,
            "domain": domain_name,
            "email": email,
            "channel": preferred_channel
        }))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            delegated_to_umang_core = true;
            if let Ok(j) = resp.json::<serde_json::Value>().await {
                if let Some(m) = j.get("delivery_mode").and_then(|v| v.as_str()) {
                    delivery_mode = m.to_string();
                }
                if let Some(dev_code) = j.get("dev_otp_preview").and_then(|v| v.as_str()) {
                    fallback_otp = dev_code.to_string();
                }
            }
        }
        Ok(resp) if resp.status() == StatusCode::PAYMENT_REQUIRED => {
            return Err((
                StatusCode::PAYMENT_REQUIRED,
                Json(serde_json::json!({
                    "error": "Daily UMANG OTP quota exceeded for this tenant tier."
                })),
            ));
        }
        _ => {
            if !state.allow_local_otp_fallback {
                tracing::error!(
                    "[UMANG Auth] UMANG Core unreachable at {} and ALLOW_LOCAL_OTP_FALLBACK is disabled",
                    umang_instance_url
                );
                return Err((
                    StatusCode::BAD_GATEWAY,
                    Json(serde_json::json!({
                        "error": "UMANG identity service is temporarily unavailable. Please try again shortly."
                    })),
                ));
            }
            // Resilient local fallback if UMANG Core process is restarting (dev/test only unless explicitly enabled)
            let otp_num: u32 = rand::thread_rng().gen_range(100_000..=999_999);
            fallback_otp = format!("{:06}", otp_num);
            let bridge_url = format!(
                "{}/api/dispatch-otp",
                state.umang_core_url.trim_end_matches('/')
            );
            let _ = client
                .post(&bridge_url)
                .timeout(std::time::Duration::from_secs(6))
                .header("X-API-Key", &state.umang_api_key)
                .header("X-Tenant-ID", &state.umang_tenant_id)
                .json(&serde_json::json!({
                    "phone": phone,
                    "otp": fallback_otp,
                    "channel": preferred_channel,
                    "domain": domain_name,
                    "email": email
                }))
                .send()
                .await;
            delivery_mode = "umang-local-resilience".to_string();
        }
    }

    let expires_at = now + 300; // 5-minute TTL
    state.otp_cache.write().await.insert(
        phone.clone(),
        CachedOtpEntry {
            otp: fallback_otp.clone(),
            issued_at: now,
            expires_at,
            email: email.clone(),
            tenant_id: tenant_id.clone(),
            domain: domain_name.clone(),
            attempts: 0,
            window_start,
            window_count,
            delegated_to_umang_core,
        },
    );

    tracing::info!(
        "🔐 [UMANG CORE OTP DISPATCHED] Phone: {} | Mailbox: {} | Domain: {} | Channel: {} | Mode: {}",
        phone,
        mask_email_hint(&email),
        domain_name,
        preferred_channel,
        delivery_mode
    );

    let mut response_json = serde_json::json!({
        "message": format!("Verification code dispatched via {}", preferred_channel.to_uppercase()),
        "phone": phone,
        "email_hint": if state.allow_dev_otp_preview { email } else { mask_email_hint(&email) },
        "domain": domain_name,
        "channel": preferred_channel,
        "delivery_mode": delivery_mode,
        "umang_tenant_id": state.umang_tenant_id,
        "ttl_seconds": 300
    });

    if state.allow_dev_otp_preview && !fallback_otp.is_empty() {
        if let Some(obj) = response_json.as_object_mut() {
            obj.insert("dev_otp_preview".into(), serde_json::json!(fallback_otp));
            obj.insert(
                "web_otp_hint".into(),
                serde_json::json!(format!("@{} #{}", domain_name, fallback_otp)),
            );
        }
    }

    Ok(Json(response_json))
}

/// POST /api/auth/verify-otp
pub async fn verify_otp_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<VerifyOtpPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let phone = normalize_lesotho_phone(&payload.phone).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Invalid phone number format." })),
        )
    })?;

    let submitted_otp = payload.otp.trim();
    if submitted_otp.len() != 6 || !submitted_otp.chars().all(|c| c.is_ascii_digit()) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "A valid 6-digit numeric OTP is required." })),
        ));
    }

    let now = chrono::Utc::now().timestamp();
    let cached_snapshot = {
        let cache = state.otp_cache.read().await;
        cache.get(&phone).cloned()
    };

    if !state.allow_dev_otp_preview {
        if let Some(ref entry) = cached_snapshot {
            if entry.attempts >= 5 && entry.expires_at > now {
                return Err((
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(serde_json::json!({
                        "error": "Too many failed verification attempts. Please request a new code."
                    })),
                ));
            }
        }
    }

    let target_domain = payload
        .domain
        .clone()
        .or_else(|| cached_snapshot.as_ref().map(|c| c.domain.clone()));
    let target_email = cached_snapshot.as_ref().map(|c| c.email.clone());

    // 1. Primary Path: Verify & Consume OTP against UMANG Core Engine (`tnt_ka_posong`)
    let umang_verify_url = format!(
        "{}/api/v1/instances/{}/auth/verify-otp",
        state.umang_core_url.trim_end_matches('/'),
        state.umang_tenant_id
    );

    let mut umang_verified = false;
    let mut umang_id_token: Option<String> = None;
    let mut umang_refresh_token: Option<String> = None;

    if let Ok(resp) = reqwest::Client::new()
        .post(&umang_verify_url)
        .timeout(std::time::Duration::from_secs(8))
        .header("X-API-Key", &state.umang_api_key)
        .header("X-Tenant-ID", &state.umang_tenant_id)
        .header("X-Umang-Client-Id", &state.umang_client_id)
        .json(&serde_json::json!({
            "phone": phone,
            "otp": submitted_otp,
            "domain": target_domain,
            "email": target_email,
            "clientId": state.umang_client_id
        }))
        .send()
        .await
    {
        if resp.status().is_success() {
            umang_verified = true;
            if let Ok(j) = resp.json::<serde_json::Value>().await {
                umang_id_token = j
                    .get("id_token")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                umang_refresh_token = j
                    .get("refresh_token")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
            // Evict local cache entry upon successful UMANG Core verification
            state.otp_cache.write().await.remove(&phone);
        } else if resp.status() == StatusCode::UNAUTHORIZED {
            // UMANG Core explicitly rejected the OTP -> increment local attempt counter and lock out on >= 5 failures
            let mut locked = false;
            {
                let mut cache = state.otp_cache.write().await;
                if let Some(entry) = cache.get_mut(&phone) {
                    entry.attempts += 1;
                    if entry.attempts >= 5 {
                        entry.otp.clear();
                        if !state.allow_dev_otp_preview {
                            locked = true;
                        } else {
                            cache.remove(&phone);
                        }
                    }
                }
            }
            if locked {
                return Err((
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(serde_json::json!({
                        "error": "Too many failed verification attempts. Please request a new code."
                    })),
                ));
            }
            return Err((
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({
                    "error": "Invalid or expired verification code. Please try again."
                })),
            ));
        } else if resp.status() == StatusCode::TOO_MANY_REQUESTS {
            return Err((
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::json!({
                    "error": "Too many failed verification attempts. Please request a new code."
                })),
            ));
        }
    }

    // 2. Fallback verification against local cache ONLY if UMANG Core was unreachable during dispatch
    // and ALLOW_LOCAL_OTP_FALLBACK is enabled (dev/test mode)
    if !umang_verified && state.allow_local_otp_fallback {
        let mut cache = state.otp_cache.write().await;
        match cache.get_mut(&phone) {
            Some(entry) if !entry.delegated_to_umang_core && entry.expires_at > now => {
                if !entry.otp.is_empty() && constant_time_eq(&entry.otp, submitted_otp) {
                    cache.remove(&phone);
                    umang_verified = true;
                } else {
                    entry.attempts += 1;
                    if entry.attempts >= 5 {
                        entry.otp.clear();
                        if !state.allow_dev_otp_preview {
                            return Err((
                                StatusCode::TOO_MANY_REQUESTS,
                                Json(serde_json::json!({
                                    "error": "Too many failed verification attempts. Please request a new code."
                                })),
                            ));
                        } else {
                            cache.remove(&phone);
                        }
                    }
                }
            }
            Some(entry) if entry.expires_at <= now => {
                cache.remove(&phone);
            }
            _ => {}
        }
    }

    if !umang_verified {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": "Invalid or expired verification code. Please request a new one."
            })),
        ));
    }

    // 3. Re-verify mailbox & tenant eligibility in ka-posong SQLite before issuing session
    let row = if let Some(ref email_key) = target_email {
        sqlx::query(
            r#"SELECT m.email, m.tenant_id, m.domain_name, m.display_name, m.role, m.whatsapp_otp_enabled, m.status AS mbx_status,
                      t.org_name, t.tier, t.status AS tnt_status
               FROM mailboxes m
               JOIN tenants t ON t.id = m.tenant_id
               WHERE m.email = ? AND m.phone = ?
               LIMIT 1"#,
        )
        .bind(email_key)
        .bind(&phone)
        .fetch_optional(&state.db)
        .await
    } else if let Some(ref dom) = target_domain {
        sqlx::query(
            r#"SELECT m.email, m.tenant_id, m.domain_name, m.display_name, m.role, m.whatsapp_otp_enabled, m.status AS mbx_status,
                      t.org_name, t.tier, t.status AS tnt_status
               FROM mailboxes m
               JOIN tenants t ON t.id = m.tenant_id
               WHERE m.phone = ? AND m.domain_name = ?
               LIMIT 1"#,
        )
        .bind(&phone)
        .bind(dom.trim().to_lowercase())
        .fetch_optional(&state.db)
        .await
    } else {
        sqlx::query(
            r#"SELECT m.email, m.tenant_id, m.domain_name, m.display_name, m.role, m.whatsapp_otp_enabled, m.status AS mbx_status,
                      t.org_name, t.tier, t.status AS tnt_status
               FROM mailboxes m
               JOIN tenants t ON t.id = m.tenant_id
               WHERE m.phone = ?
               ORDER BY m.created_at ASC LIMIT 1"#,
        )
        .bind(&phone)
        .fetch_optional(&state.db)
        .await
    }
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
    })?
    .ok_or_else(|| {
        (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "User mailbox no longer exists." })),
        )
    })?;

    let mbx_status: String = row.get("mbx_status");
    let tnt_status: String = row.get("tnt_status");
    if mbx_status != "ACTIVE" || tnt_status != "ACTIVE" {
        return Err((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Account deactivated prior to verification." })),
        ));
    }

    let email: String = row.get("email");
    let tenant_id: String = row.get("tenant_id");
    let domain_name: String = row.get("domain_name");
    let display_name: String = row.get("display_name");
    let role: String = row.get("role");
    let tier: String = row.get("tier");
    let wa_enabled: i64 = row.get("whatsapp_otp_enabled");

    let iat = chrono::Utc::now().timestamp() as usize;
    let exp = iat + (8 * 3600); // 8-hour UMANG session lifetime
    let jti = format!("jti_{}", uuid::Uuid::new_v4().simple());

    let claims = UmangJwtClaims {
        sub: email.clone(),
        jti,
        phone: phone.clone(),
        email: email.clone(),
        name: display_name.clone(),
        client_id: tenant_id.clone(),
        tenant_id: tenant_id.clone(),
        domain: domain_name.clone(),
        role: role.clone(),
        access: "full".into(),
        subscription: tier.to_lowercase(),
        plan_id: format!("plan_{}", tier.to_lowercase()),
        exp,
        iat,
    };

    let token = sign_umang_jwt(&claims, &state.jwt_secret);

    let client_info = UmangClientInfo {
        phone: phone.clone(),
        email: email.clone(),
        client_id: tenant_id,
        umang_tenant_id: state.umang_tenant_id.clone(),
        name: display_name,
        domain: domain_name,
        role,
        access: "full".into(),
        subscription: tier.to_lowercase(),
        plan_id: format!("plan_{}", tier.to_lowercase()),
        subscribed_to_whatsapp_otp: wa_enabled == 1,
        status: "active".into(),
    };

    Ok(Json(serde_json::json!({
        "message": "Authentication successful",
        "umang_verified": true,
        "umang_tenant_id": state.umang_tenant_id,
        "token": token,
        "id_token": umang_id_token.unwrap_or_else(|| token.clone()),
        "refresh_token": umang_refresh_token,
        "client": client_info
    })))
}

/// POST /api/auth/sso-exchange
/// Exchanges an OAuth 2.0 `authorization_code` + PKCE `code_verifier` with UMANG Core Engine
pub async fn sso_exchange_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SsoExchangePayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let token_url = format!(
        "{}/api/v1/sso/token",
        state.umang_core_url.trim_end_matches('/')
    );

    let resp = reqwest::Client::new()
        .post(&token_url)
        .timeout(std::time::Duration::from_secs(8))
        .header("X-API-Key", &state.umang_api_key)
        .header("X-Tenant-ID", &state.umang_tenant_id)
        .json(&serde_json::json!({
            "grant_type": "authorization_code",
            "code": payload.code,
            "code_verifier": payload.code_verifier,
            "redirect_uri": payload.redirect_uri,
            "client_id": state.umang_client_id
        }))
        .send()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": format!("UMANG Core SSO unreachable: {}", e) })),
            )
        })?;

    if !resp.status().is_success() {
        let err_json = resp
            .json::<serde_json::Value>()
            .await
            .unwrap_or_else(|_| serde_json::json!({ "error": "SSO code exchange failed" }));
        return Err((StatusCode::UNAUTHORIZED, Json(err_json)));
    }

    let sso_data = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e.to_string() }))))?;

    let phone = sso_data
        .get("user")
        .and_then(|u| u.get("phone"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "UMANG SSO response missing user phone" })),
            )
        })?;

    let row = if let Some(ref dom) = payload.domain {
        sqlx::query(
            r#"SELECT m.email, m.tenant_id, m.domain_name, m.display_name, m.role, m.whatsapp_otp_enabled,
                      t.tier
               FROM mailboxes m
               JOIN tenants t ON t.id = m.tenant_id
               WHERE m.phone = ? AND m.domain_name = ? AND m.status = 'ACTIVE' AND t.status = 'ACTIVE'
               LIMIT 1"#,
        )
        .bind(phone)
        .bind(dom.trim().to_lowercase())
        .fetch_optional(&state.db)
        .await
    } else {
        sqlx::query(
            r#"SELECT m.email, m.tenant_id, m.domain_name, m.display_name, m.role, m.whatsapp_otp_enabled,
                      t.tier
               FROM mailboxes m
               JOIN tenants t ON t.id = m.tenant_id
               WHERE m.phone = ? AND m.status = 'ACTIVE' AND t.status = 'ACTIVE'
               ORDER BY m.created_at ASC LIMIT 1"#,
        )
        .bind(phone)
        .fetch_optional(&state.db)
        .await
    }
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
    })?
    .ok_or_else(|| {
        (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "No active uMail mailbox bound to this UMANG identity." })),
        )
    })?;

    let email: String = row.get("email");
    let tenant_id: String = row.get("tenant_id");
    let domain_name: String = row.get("domain_name");
    let display_name: String = row.get("display_name");
    let role: String = row.get("role");
    let tier: String = row.get("tier");
    let wa_enabled: i64 = row.get("whatsapp_otp_enabled");

    let iat = chrono::Utc::now().timestamp() as usize;
    let exp = iat + (8 * 3600);
    let jti = format!("jti_{}", uuid::Uuid::new_v4().simple());

    let claims = UmangJwtClaims {
        sub: email.clone(),
        jti,
        phone: phone.to_string(),
        email: email.clone(),
        name: display_name.clone(),
        client_id: tenant_id.clone(),
        tenant_id: tenant_id.clone(),
        domain: domain_name.clone(),
        role: role.clone(),
        access: "full".into(),
        subscription: tier.to_lowercase(),
        plan_id: format!("plan_{}", tier.to_lowercase()),
        exp,
        iat,
    };

    let token = sign_umang_jwt(&claims, &state.jwt_secret);

    let client_info = UmangClientInfo {
        phone: phone.to_string(),
        email,
        client_id: tenant_id,
        umang_tenant_id: state.umang_tenant_id.clone(),
        name: display_name,
        domain: domain_name,
        role,
        access: "full".into(),
        subscription: tier.to_lowercase(),
        plan_id: format!("plan_{}", tier.to_lowercase()),
        subscribed_to_whatsapp_otp: wa_enabled == 1,
        status: "active".into(),
    };

    Ok(Json(serde_json::json!({
        "message": "UMANG OIDC/OAuth2 SSO authentication successful",
        "umang_verified": true,
        "umang_tenant_id": state.umang_tenant_id,
        "token": token,
        "id_token": sso_data.get("id_token").cloned().unwrap_or(serde_json::json!(token)),
        "refresh_token": sso_data.get("refresh_token").cloned().unwrap_or(serde_json::Value::Null),
        "client": client_info
    })))
}

/// POST /api/auth/logout
/// Revokes the active session token locally in `revoked_tokens` AND in UMANG Core's `revoked_jti` store
pub async fn logout_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    payload: Option<Json<LogoutPayload>>,
) -> Json<serde_json::Value> {
    let bearer = headers
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.to_string());
    let token = payload
        .and_then(|p| p.0.token)
        .or(bearer)
        .unwrap_or_default();

    if !token.is_empty() {
        revoke_token(&state.db, &token, &state.jwt_secret).await;

        let revoke_url = format!(
            "{}/api/v1/sso/revoke",
            state.umang_core_url.trim_end_matches('/')
        );
        let _ = reqwest::Client::new()
            .post(&revoke_url)
            .timeout(std::time::Duration::from_secs(4))
            .header("X-API-Key", &state.umang_api_key)
            .header("X-Tenant-ID", &state.umang_tenant_id)
            .json(&serde_json::json!({ "token": token }))
            .send()
            .await;
    }

    Json(serde_json::json!({
        "revoked": true,
        "message": "Session revoked across ka-posong and UMANG Core."
    }))
}

/// POST /api/v1/webhooks/umang
/// Receives HMAC-SHA256 signed Extending Arm events (`X-Umang-Signature`) from UMANG Core Engine
pub async fn umang_webhook_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let sig_header = headers
        .get("X-Umang-Signature")
        .or_else(|| headers.get("X-KaPosong-Signature"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let clean_sig = sig_header.strip_prefix("sha256=").unwrap_or(sig_header);
    let expected_sig = compute_hmac_hex(&state.umang_webhook_secret, &body);

    if clean_sig.is_empty() || !constant_time_eq(clean_sig, &expected_sig) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": "Invalid X-Umang-Signature HMAC-SHA256 signature"
            })),
        ));
    }

    let payload: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
    let event_type = payload
        .get("event_type")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let tenant_id = payload
        .get("tenant_id")
        .and_then(|v| v.as_str())
        .unwrap_or("tnt_ka_posong");

    if event_type == "token.revoked" || event_type == "user.revoked" {
        let jti_opt = payload
            .get("data")
            .and_then(|d| d.get("jti"))
            .and_then(|v| v.as_str())
            .or_else(|| payload.get("jti").and_then(|v| v.as_str()));
        if let Some(jti) = jti_opt {
            let exp = chrono::Utc::now().timestamp() + (8 * 3600);
            revoke_jti(&state.db, jti, exp).await;
        }
        if let Some(tok) = payload
            .get("data")
            .and_then(|d| d.get("token"))
            .and_then(|v| v.as_str())
        {
            revoke_token(&state.db, tok, &state.jwt_secret).await;
        }
    }

    tracing::info!(
        "📡 [UMANG EXTENDING ARM WEBHOOK VERIFIED] Event: {} | Tenant: {}",
        event_type,
        tenant_id
    );

    Ok(Json(serde_json::json!({
        "status": "ACK",
        "verified": true,
        "event_type": event_type,
        "tenant_id": tenant_id
    })))
}
