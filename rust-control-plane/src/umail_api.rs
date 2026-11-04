// ============================================================================
// KA-POSONG UMAIL WEB CLIENT API HANDLERS (src/umail_api.rs)
// Powers the LitHTML + TypeScript PWA at `/umail` for every tenant domain
// ============================================================================

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::sync::Arc;

use crate::{
    arms_webhook::dispatch_tenant_event,
    auth::{verify_umang_jwt, UmangJwtClaims},
    smtp_injector::inject_smtp_to_stalwart,
    AppState,
};

#[derive(Debug, Deserialize)]
pub struct ListMessagesQuery {
    pub folder: Option<String>,
    pub q: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MailMessageDto {
    pub id: String,
    pub folder: String,
    pub sender_name: String,
    pub sender_email: String,
    pub recipient_email: String,
    pub subject: String,
    pub preview: String,
    pub body_text: String,
    pub body_html: Option<String>,
    pub is_read: bool,
    pub is_starred: bool,
    pub spf_dmarc_status: String,
    pub received_at: String,
}

#[derive(Debug, Deserialize)]
pub struct SendMailPayload {
    pub to: String,
    pub subject: String,
    pub body_text: String,
    pub body_html: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PatchMessagePayload {
    pub is_read: Option<bool>,
    pub is_starred: Option<bool>,
    pub folder: Option<String>,
}

fn extract_jwt_user(
    headers: &HeaderMap,
    secret: &str,
) -> Result<UmangJwtClaims, (StatusCode, Json<serde_json::Value>)> {
    let token = headers
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "Missing Bearer JWT token" })),
            )
        })?;

    verify_umang_jwt(token, secret).ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired UMANG session token" })),
        )
    })
}

/// GET /api/umail/messages
pub async fn list_umail_messages(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ListMessagesQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let claims = extract_jwt_user(&headers, &state.jwt_secret)?;
    let folder = query.folder.unwrap_or_else(|| "inbox".to_string());

    let rows = if let Some(ref search) = query.q {
        let pattern = format!("%{}%", search);
        sqlx::query(
            r#"SELECT id, folder, sender_name, sender_email, recipient_email, subject, preview, body_text, body_html,
                      is_read, is_starred, spf_dmarc_status, received_at
               FROM mail_messages
               WHERE mailbox_email = ? AND (subject LIKE ? OR sender_email LIKE ? OR body_text LIKE ?)
               ORDER BY received_at DESC LIMIT 100"#,
        )
        .bind(&claims.email)
        .bind(&pattern)
        .bind(&pattern)
        .bind(&pattern)
        .fetch_all(&state.db)
        .await
    } else if folder == "starred" {
        sqlx::query(
            r#"SELECT id, folder, sender_name, sender_email, recipient_email, subject, preview, body_text, body_html,
                      is_read, is_starred, spf_dmarc_status, received_at
               FROM mail_messages
               WHERE mailbox_email = ? AND is_starred = 1
               ORDER BY received_at DESC LIMIT 100"#,
        )
        .bind(&claims.email)
        .fetch_all(&state.db)
        .await
    } else {
        sqlx::query(
            r#"SELECT id, folder, sender_name, sender_email, recipient_email, subject, preview, body_text, body_html,
                      is_read, is_starred, spf_dmarc_status, received_at
               FROM mail_messages
               WHERE mailbox_email = ? AND folder = ?
               ORDER BY received_at DESC LIMIT 100"#,
        )
        .bind(&claims.email)
        .bind(&folder)
        .fetch_all(&state.db)
        .await
    }
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
    })?;

    let messages: Vec<MailMessageDto> = rows
        .into_iter()
        .map(|r| MailMessageDto {
            id: r.get("id"),
            folder: r.get("folder"),
            sender_name: r.get("sender_name"),
            sender_email: r.get("sender_email"),
            recipient_email: r.get("recipient_email"),
            subject: r.get("subject"),
            preview: r.get("preview"),
            body_text: r.get("body_text"),
            body_html: r.get("body_html"),
            is_read: r.get::<i64, _>("is_read") == 1,
            is_starred: r.get::<i64, _>("is_starred") == 1,
            spf_dmarc_status: r.get("spf_dmarc_status"),
            received_at: r.get("received_at"),
        })
        .collect();

    Ok(Json(serde_json::json!({
        "mailbox": claims.email,
        "phone": claims.phone,
        "domain": claims.domain,
        "folder": folder,
        "messages": messages
    })))
}

/// POST /api/umail/send
pub async fn send_umail_message(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<SendMailPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let claims = extract_jwt_user(&headers, &state.jwt_secret)?;
    let recipient = payload.to.trim().to_lowercase();
    if !recipient.contains('@') {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Invalid recipient email address" })),
        ));
    }

    let msg_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    let now_rfc2822 = chrono::Utc::now().to_rfc2822();
    let preview: String = payload.body_text.chars().take(120).collect();

    let raw_mime = format!(
        "From: {} <{}>\r\nTo: <{}>\r\nSubject: {}\r\nDate: {}\r\nMessage-ID: <{}@{}>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{}",
        claims.name,
        claims.email,
        recipient,
        payload.subject,
        now_rfc2822,
        msg_id,
        claims.domain,
        payload.body_text
    );

    // 1. Store in sender's 'sent' folder
    sqlx::query(
        r#"INSERT INTO mail_messages
           (id, tenant_id, mailbox_email, folder, sender_name, sender_email, recipient_email, subject, preview, body_text, body_html, raw_mime, is_read, spf_dmarc_status)
           VALUES (?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, 1, 'DKIM-SIGNED')"#,
    )
    .bind(&msg_id)
    .bind(&claims.client_id)
    .bind(&claims.email)
    .bind(&claims.name)
    .bind(&claims.email)
    .bind(&recipient)
    .bind(&payload.subject)
    .bind(&preview)
    .bind(&payload.body_text)
    .bind(&payload.body_html)
    .bind(&raw_mime)
    .execute(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
    })?;

    // 2. If recipient is also a local tenant mailbox, deliver directly into their inbox
    let local_rcpt = sqlx::query("SELECT tenant_id FROM mailboxes WHERE email = ?")
        .bind(&recipient)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();

    if let Some(rcpt_row) = local_rcpt {
        let rcpt_tid: String = rcpt_row.get("tenant_id");
        let inbox_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
        let _ = sqlx::query(
            r#"INSERT INTO mail_messages
               (id, tenant_id, mailbox_email, folder, sender_name, sender_email, recipient_email, subject, preview, body_text, body_html, raw_mime, is_read, spf_dmarc_status)
               VALUES (?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, 0, 'PASS (Internal DKIM)')"#,
        )
        .bind(&inbox_id)
        .bind(&rcpt_tid)
        .bind(&recipient)
        .bind(&claims.name)
        .bind(&claims.email)
        .bind(&recipient)
        .bind(&payload.subject)
        .bind(&preview)
        .bind(&payload.body_text)
        .bind(&payload.body_html)
        .bind(&raw_mime)
        .execute(&state.db)
        .await;
    }

    // 3. Inject into Stalwart SMTP engine for JMAP/IMAP sync and external Port 587 relay
    let injected = inject_smtp_to_stalwart(
        &state.stalwart_smtp_addr,
        &claims.email,
        &recipient,
        raw_mime.as_bytes(),
    )
    .await
    .unwrap_or(false);

    // 4. Fire Extending Arm webhook event
    dispatch_tenant_event(
        &state.db,
        &claims.client_id,
        "mail.sent",
        serde_json::json!({
            "message_id": msg_id,
            "from": claims.email,
            "to": recipient,
            "subject": payload.subject
        }),
    )
    .await;

    Ok(Json(serde_json::json!({
        "status": "SENT",
        "message_id": msg_id,
        "from": claims.email,
        "to": recipient,
        "stalwart_relayed": injected
    })))
}

/// PATCH /api/umail/messages/:id
pub async fn patch_umail_message(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(msg_id): Path<String>,
    Json(payload): Json<PatchMessagePayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let claims = extract_jwt_user(&headers, &state.jwt_secret)?;

    if let Some(read) = payload.is_read {
        let _ = sqlx::query(
            "UPDATE mail_messages SET is_read = ? WHERE id = ? AND mailbox_email = ?",
        )
        .bind(if read { 1 } else { 0 })
        .bind(&msg_id)
        .bind(&claims.email)
        .execute(&state.db)
        .await;
    }

    if let Some(starred) = payload.is_starred {
        let _ = sqlx::query(
            "UPDATE mail_messages SET is_starred = ? WHERE id = ? AND mailbox_email = ?",
        )
        .bind(if starred { 1 } else { 0 })
        .bind(&msg_id)
        .bind(&claims.email)
        .execute(&state.db)
        .await;
    }

    if let Some(ref folder) = payload.folder {
        let _ = sqlx::query(
            "UPDATE mail_messages SET folder = ? WHERE id = ? AND mailbox_email = ?",
        )
        .bind(folder)
        .bind(&msg_id)
        .bind(&claims.email)
        .execute(&state.db)
        .await;
    }

    Ok(Json(serde_json::json!({
        "status": "UPDATED",
        "id": msg_id
    })))
}
