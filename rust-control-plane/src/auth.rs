// ============================================================================
// KA-POSONG STRICT RBAC & UMANG JWT AUTHENTICATION MIDDLEWARE (src/auth.rs)
// Roles: DEVOPS_MASTER (SuperAdmin), TENANT_ADMIN, EXTENDING_ARM, UMAIL_USER
// ============================================================================

use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Json, Response},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::sync::Arc;

use crate::AppState;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Role {
    DevOpsMaster,
    TenantAdmin { tenant_id: String },
    ExtendingArm {
        module_id: String,
        tenant_id: String,
        scopes: Vec<String>,
    },
    UmailUser {
        email: String,
        phone: String,
        tenant_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthContext {
    pub role: Role,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UmangJwtClaims {
    pub sub: String,
    pub phone: String,
    pub email: String,
    pub name: String,
    #[serde(rename = "clientId")]
    pub client_id: String,
    pub domain: String,
    pub role: String,
    pub access: String,
    pub subscription: String,
    #[serde(rename = "planId")]
    pub plan_id: String,
    pub exp: usize,
    pub iat: usize,
}

pub fn hash_api_key(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn compute_hmac_hex(secret: &str, data: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .expect("HMAC can take key of any size");
    mac.update(data);
    hex::encode(mac.finalize().into_bytes())
}

pub fn sign_umang_jwt(claims: &UmangJwtClaims, secret: &str) -> String {
    let header = serde_json::json!({ "alg": "HS256", "typ": "JWT" });
    let h_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap_or_default());
    let p_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap_or_default());
    let signing_input = format!("{}.{}", h_b64, p_b64);

    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(signing_input.as_bytes());
    let sig_b64 = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

    format!("{}.{}", signing_input, sig_b64)
}

pub fn verify_umang_jwt(token: &str, secret: &str) -> Option<UmangJwtClaims> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(signing_input.as_bytes());
    let expected_sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    if expected_sig != parts[2] {
        return None;
    }
    let payload_bytes = URL_SAFE_NO_PAD.decode(parts[1]).ok()?;
    let claims: UmangJwtClaims = serde_json::from_slice(&payload_bytes).ok()?;
    let now = chrono::Utc::now().timestamp() as usize;
    if claims.exp <= now {
        return None;
    }
    Some(claims)
}

pub async fn resolve_auth_context(
    state: &Arc<AppState>,
    headers: &HeaderMap,
) -> Result<AuthContext, (StatusCode, String)> {
    // 1. Check Bearer JWT token first (for uMail User or Scoped JWT)
    if let Some(bearer) = headers
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
    {
        if bearer == state.master_devops_key {
            return Ok(AuthContext {
                role: Role::DevOpsMaster,
            });
        }
        if let Some(claims) = verify_umang_jwt(bearer, &state.jwt_secret) {
            return Ok(AuthContext {
                role: Role::UmailUser {
                    email: claims.email,
                    phone: claims.phone,
                    tenant_id: claims.client_id,
                },
            });
        }
    }

    // 2. Check X-API-Key header
    let api_key = headers
        .get("X-API-Key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                "Missing X-API-Key or Authorization Bearer header".to_string(),
            )
        })?;

    if api_key == state.master_devops_key {
        return Ok(AuthContext {
            role: Role::DevOpsMaster,
        });
    }

    let key_hash = hash_api_key(api_key);
    let requested_tenant = headers.get("X-Tenant-ID").and_then(|v| v.to_str().ok());

    // 3. Check Tenants table for TENANT_ADMIN key
    let tenant_row = sqlx::query(
        "SELECT id, status FROM tenants WHERE (api_key_hash = ? OR raw_api_key = ?)",
    )
    .bind(&key_hash)
    .bind(api_key)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if let Some(row) = tenant_row {
        let tenant_id: String = row.get("id");
        let status: String = row.get("status");
        if status != "ACTIVE" {
            return Err((
                StatusCode::FORBIDDEN,
                "Tenant account is suspended".to_string(),
            ));
        }
        if let Some(req_tid) = requested_tenant {
            if req_tid != tenant_id {
                return Err((
                    StatusCode::FORBIDDEN,
                    "X-Tenant-ID mismatch for this Tenant API Key".to_string(),
                ));
            }
        }
        return Ok(AuthContext {
            role: Role::TenantAdmin { tenant_id },
        });
    }

    // 4. Check Extending Arms table for EXTENDING_ARM key
    let arm_row = sqlx::query(
        "SELECT module_id, tenant_id, scopes, enabled FROM extending_arms WHERE (api_key_hash = ? OR raw_api_key = ?)",
    )
    .bind(&key_hash)
    .bind(api_key)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if let Some(row) = arm_row {
        let enabled: i64 = row.get("enabled");
        if enabled == 0 {
            return Err((
                StatusCode::FORBIDDEN,
                "Extending Arm module is disabled".to_string(),
            ));
        }
        let module_id: String = row.get("module_id");
        let tenant_id: String = row.get("tenant_id");
        let scopes_str: String = row.get("scopes");
        if let Some(req_tid) = requested_tenant {
            if req_tid != tenant_id {
                return Err((
                    StatusCode::FORBIDDEN,
                    "X-Tenant-ID mismatch for Extending Arm module".to_string(),
                ));
            }
        }
        let scopes = scopes_str
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        return Ok(AuthContext {
            role: Role::ExtendingArm {
                module_id,
                tenant_id,
                scopes,
            },
        });
    }

    Err((
        StatusCode::FORBIDDEN,
        "Invalid or unauthorized API key".to_string(),
    ))
}

pub async fn rbac_middleware(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    mut request: Request,
    next: Next,
) -> Response {
    match resolve_auth_context(&state, &headers).await {
        Ok(ctx) => {
            request.extensions_mut().insert(ctx);
            next.run(request).await
        }
        Err((status, message)) => (
            status,
            Json(serde_json::json!({
                "error": message,
                "status": status.as_u16()
            })),
        )
            .into_response(),
    }
}
