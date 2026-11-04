// ============================================================================
// KA-POSONG UMANG IDENTITY & OTP AUTHENTICATION ENGINE (src/umang_auth.rs)
// Strictly binds Lesotho E.164 Phone Numbers (+266########) to Tenant Mailboxes
// and dispatches 6-digit OTPs via SMS or WhatsApp (AetherWA) with 8-hour JWTs.
// ============================================================================

use axum::{
    extract::State,
    http::StatusCode,
    response::Json,
};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::sync::Arc;

use crate::{
    auth::{sign_umang_jwt, UmangJwtClaims},
    AppState,
};

#[derive(Debug, Clone)]
pub struct CachedOtpEntry {
    pub otp: String,
    pub expires_at: i64,
    pub email: String,
    pub tenant_id: String,
    pub domain: String,
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
    pub otp: String,
    pub domain: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UmangClientInfo {
    pub phone: String,
    pub email: String,
    #[serde(rename = "clientId")]
    pub client_id: String,
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
    if digits.len() == 8 && (digits.starts_with('5') || digits.starts_with('6') || digits.starts_with('2')) {
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

/// POST /api/auth/request-otp
pub async fn request_otp_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RequestOtpPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let phone = normalize_lesotho_phone(&payload.phone).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Invalid Lesotho phone number format. Expected +266######## or 8 digits (e.g. 57284264)."
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
        .bind(dom)
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
                "error": format!("No provisioned uMail inbox is bound to phone {}. Contact your domain administrator.", phone)
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
    let wa_enabled: i64 = row.get("whatsapp_otp_enabled");

    // Generate cryptographically random 6-digit OTP
    let otp_num: u32 = rand::thread_rng().gen_range(100_000..=999_999);
    let otp = format!("{:06}", otp_num);
    let expires_at = chrono::Utc::now().timestamp() + 300; // 5-minute TTL

    state.otp_cache.write().await.insert(
        phone.clone(),
        CachedOtpEntry {
            otp: otp.clone(),
            expires_at,
            email: email.clone(),
            tenant_id: tenant_id.clone(),
            domain: domain_name.clone(),
        },
    );

    let preferred_channel = payload.channel.unwrap_or_else(|| {
        if wa_enabled == 1 {
            "whatsapp".to_string()
        } else {
            "sms".to_string()
        }
    });

    tracing::info!(
        "🔑 [UMANG OTP ISSUED] Phone: {} | Mailbox: {} | Code: {} | Channel: {}",
        phone,
        email,
        otp,
        preferred_channel
    );

    // Dispatch to UMANG OTP Delivery Bridge (WhatsApp AetherWA + Huawei Router SMS)
    let bridge_url = format!(
        "{}/api/dispatch-otp",
        state.umang_otp_bridge_url.trim_end_matches('/')
    );
    let bridge_payload = serde_json::json!({
        "phone": phone,
        "otp": otp,
        "channel": preferred_channel,
        "domain": domain_name,
        "email": email
    });

    let mut delivery_mode = "umang-console-win-win".to_string();
    if let Ok(resp) = reqwest::Client::new()
        .post(&bridge_url)
        .timeout(std::time::Duration::from_secs(12))
        .json(&bridge_payload)
        .send()
        .await
    {
        if let Ok(j) = resp.json::<serde_json::Value>().await {
            if let Some(m) = j.get("mode").and_then(|v| v.as_str()) {
                delivery_mode = m.to_string();
            } else if let Some(ch) = j.get("channel").and_then(|v| v.as_str()) {
                delivery_mode = ch.to_string();
            }
        }
    }

    Ok(Json(serde_json::json!({
        "message": format!("OTP generated and dispatched via {}", preferred_channel.to_uppercase()),
        "phone": phone,
        "email_hint": email,
        "domain": domain_name,
        "channel": preferred_channel,
        "delivery_mode": delivery_mode,
        "ttl_seconds": 300,
        "web_otp_hint": format!("@{} #{}", domain_name, otp),
        "dev_otp_preview": if state.allow_dev_otp_preview { Some(otp) } else { None }
    })))
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
    if submitted_otp.len() != 6 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "6-digit OTP is required." })),
        ));
    }

    let now = chrono::Utc::now().timestamp();
    let cached = {
        let mut cache = state.otp_cache.write().await;
        match cache.get(&phone) {
            Some(entry) if entry.expires_at > now && entry.otp == submitted_otp => {
                // Immediately consume OTP to prevent replay attacks (UMANG invariant #4)
                cache.remove(&phone)
            }
            Some(entry) if entry.expires_at <= now => {
                cache.remove(&phone);
                None
            }
            _ => None,
        }
    };

    let _cached = cached.ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired OTP code. Please request a new one." })),
        )
    })?;

    // Re-verify eligibility immediately before issuing JWT (UMANG invariant #2)
    let row = sqlx::query(
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
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
    })?
    .ok_or_else(|| {
        (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "User account no longer exists." })),
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

    let claims = UmangJwtClaims {
        sub: email.clone(),
        phone: phone.clone(),
        email: email.clone(),
        name: display_name.clone(),
        client_id: tenant_id.clone(),
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
        "token": token,
        "client": client_info
    })))
}
