// ============================================================================
// KA-POSONG EXTENDING ARM WEBHOOK DISPATCHER (src/arms_webhook.rs)
// Dispatches HMAC-SHA256 Signed Events to CRM, Billing, and WhatsApp Bots
// ============================================================================

use reqwest::Client;
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use std::time::Duration;

use crate::auth::compute_hmac_hex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArmWebhookEvent {
    pub event_type: String,
    pub tenant_id: String,
    pub timestamp: String,
    pub data: serde_json::Value,
}

pub async fn dispatch_tenant_event(
    db: &SqlitePool,
    tenant_id: &str,
    event_type: &str,
    data: serde_json::Value,
) {
    // Check if tenant tier allows extending arms
    let allow_row = sqlx::query("SELECT allow_extending_arms FROM tenants WHERE id = ? AND status = 'ACTIVE'")
        .bind(tenant_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();

    let allow = allow_row
        .map(|r| r.get::<i64, _>("allow_extending_arms") == 1)
        .unwrap_or(false);

    if !allow {
        return;
    }

    let arms = sqlx::query(
        "SELECT module_id, module_name, webhook_url, hmac_secret FROM extending_arms WHERE tenant_id = ? AND enabled = 1",
    )
    .bind(tenant_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();

    if arms.is_empty() {
        return;
    }

    let event = ArmWebhookEvent {
        event_type: event_type.to_string(),
        tenant_id: tenant_id.to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        data,
    };

    let body_bytes = serde_json::to_vec(&event).unwrap_or_default();
    let client = Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
        .unwrap_or_else(|_| Client::new());

    for row in arms {
        let module_name: String = row.get("module_name");
        let webhook_url: String = row.get("webhook_url");
        let hmac_secret: String = row.get("hmac_secret");
        let sig = compute_hmac_hex(&hmac_secret, &body_bytes);
        let payload_clone = body_bytes.clone();
        let client_clone = client.clone();

        tokio::spawn(async move {
            let res = client_clone
                .post(&webhook_url)
                .header("Content-Type", "application/json")
                .header("X-KaPosong-Signature", format!("sha256={}", sig))
                .header("X-KaPosong-Module", &module_name)
                .body(payload_clone)
                .send()
                .await;

            if let Err(e) = res {
                tracing::debug!(
                    "[ExtendingArm] Webhook delivery to {} ({}) deferred: {}",
                    module_name,
                    webhook_url,
                    e
                );
            }
        });
    }
}
