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
    smtp_injector::{
        build_multipart_mime, dispatch_outbound_email, parse_recipient_list, AttachmentPayload,
    },
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
    pub in_reply_to: Option<String>,
    pub thread_id: Option<String>,
    pub has_attachments: bool,
    pub attachments: Option<Vec<AttachmentPayload>>,
}

#[derive(Debug, Deserialize)]
pub struct SendMailPayload {
    pub to: String,
    pub cc: Option<String>,
    pub bcc: Option<String>,
    pub subject: String,
    pub body_text: String,
    pub body_html: Option<String>,
    pub in_reply_to: Option<String>,
    pub thread_id: Option<String>,
    pub attachments: Option<Vec<AttachmentPayload>>,
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
                      is_read, is_starred, spf_dmarc_status, received_at, in_reply_to, thread_id, has_attachments, attachments
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
                      is_read, is_starred, spf_dmarc_status, received_at, in_reply_to, thread_id, has_attachments, attachments
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
                      is_read, is_starred, spf_dmarc_status, received_at, in_reply_to, thread_id, has_attachments, attachments
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
        .map(|r| {
            let has_attachments = r.try_get::<i64, _>("has_attachments").map(|v| v == 1).unwrap_or(false);
            let att_json: Option<String> = r.try_get("attachments").ok().flatten();
            let attachments: Option<Vec<AttachmentPayload>> = att_json.and_then(|j| serde_json::from_str(&j).ok());

            MailMessageDto {
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
                in_reply_to: r.try_get("in_reply_to").ok(),
                thread_id: r.try_get("thread_id").ok(),
                has_attachments,
                attachments,
            }
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

/// GET /api/umail/thread/:thread_id
/// Returns all messages (inbox & sent) in the same conversation thread
pub async fn get_umail_thread(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(thread_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let claims = extract_jwt_user(&headers, &state.jwt_secret)?;

    let rows = sqlx::query(
        r#"SELECT id, folder, sender_name, sender_email, recipient_email, subject, preview, body_text, body_html,
                  is_read, is_starred, spf_dmarc_status, received_at, in_reply_to, thread_id, has_attachments, attachments
           FROM mail_messages
           WHERE (mailbox_email = ? OR sender_email = ?)
             AND (thread_id = ? OR id = ? OR in_reply_to = ?)
           ORDER BY received_at ASC LIMIT 100"#,
    )
    .bind(&claims.email)
    .bind(&claims.email)
    .bind(&thread_id)
    .bind(&thread_id)
    .bind(&thread_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
    })?;

    let messages: Vec<MailMessageDto> = rows
        .into_iter()
        .map(|r| {
            let has_attachments = r.try_get::<i64, _>("has_attachments").map(|v| v == 1).unwrap_or(false);
            let att_json: Option<String> = r.try_get("attachments").ok().flatten();
            let attachments: Option<Vec<AttachmentPayload>> = att_json.and_then(|j| serde_json::from_str(&j).ok());

            MailMessageDto {
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
                in_reply_to: r.try_get("in_reply_to").ok(),
                thread_id: r.try_get("thread_id").ok(),
                has_attachments,
                attachments,
            }
        })
        .collect();

    Ok(Json(serde_json::json!({
        "thread_id": thread_id,
        "count": messages.len(),
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

    let to_emails = parse_recipient_list(&payload.to);
    if to_emails.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Please provide at least one valid recipient in 'To'" })),
        ));
    }
    let cc_emails = payload
        .cc
        .as_deref()
        .map(parse_recipient_list)
        .unwrap_or_default();
    let bcc_emails = payload
        .bcc
        .as_deref()
        .map(parse_recipient_list)
        .unwrap_or_default();

    let mut all_recipients: Vec<String> = Vec::new();
    for email in to_emails.iter().chain(cc_emails.iter()).chain(bcc_emails.iter()) {
        let clean = email.trim().to_lowercase();
        if !clean.is_empty() && !all_recipients.contains(&clean) {
            all_recipients.push(clean);
        }
    }

    let recipient_summary = to_emails.join(", ");

    let attachments = payload.attachments.unwrap_or_default();
    let total_attachment_bytes: usize = attachments.iter().map(|a| a.size_bytes).sum();
    const MAX_ATTACHMENTS_SIZE_BYTES: usize = 120 * 1024 * 1024; // Strict 120MB limit constraint
    if total_attachment_bytes > MAX_ATTACHMENTS_SIZE_BYTES {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({
                "error": format!(
                    "Total attachments size ({:.1} MB) exceeds the strict 120MB limit (max: {} bytes)",
                    total_attachment_bytes as f64 / (1024.0 * 1024.0),
                    MAX_ATTACHMENTS_SIZE_BYTES
                )
            })),
        ));
    }

    let msg_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    let preview: String = payload.body_text.chars().take(120).collect();

    // Derive or resolve conversation thread_id
    let thread_id = if let Some(ref tid) = payload.thread_id {
        if !tid.trim().is_empty() {
            tid.trim().to_string()
        } else {
            msg_id.clone()
        }
    } else if let Some(ref ir) = payload.in_reply_to {
        let parent_tid: Option<String> = sqlx::query_scalar(
            "SELECT thread_id FROM mail_messages WHERE id = ? OR in_reply_to = ? LIMIT 1",
        )
        .bind(ir)
        .bind(ir)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
        parent_tid.unwrap_or_else(|| ir.clone())
    } else {
        msg_id.clone()
    };

    let in_reply_to_clean = payload.in_reply_to.as_ref().map(|s| s.trim().to_string());

    let raw_mime = build_multipart_mime(
        &claims.name,
        &claims.email,
        &to_emails,
        &cc_emails,
        &payload.subject,
        &payload.body_text,
        payload.body_html.as_deref(),
        in_reply_to_clean.as_deref(),
        in_reply_to_clean.as_deref(),
        &attachments,
    );

    let has_attachments = if attachments.is_empty() { 0 } else { 1 };
    let attachments_json = if attachments.is_empty() {
        None
    } else {
        serde_json::to_string(&attachments).ok()
    };

    // 1. Store in sender's 'sent' folder
    sqlx::query(
        r#"INSERT INTO mail_messages
           (id, tenant_id, mailbox_email, folder, sender_name, sender_email, recipient_email, subject, preview, body_text, body_html, raw_mime, is_read, spf_dmarc_status, in_reply_to, thread_id, has_attachments, attachments)
           VALUES (?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, 1, 'DKIM-SIGNED', ?, ?, ?, ?)"#,
    )
    .bind(&msg_id)
    .bind(&claims.client_id)
    .bind(&claims.email)
    .bind(&claims.name)
    .bind(&claims.email)
    .bind(&recipient_summary)
    .bind(&payload.subject)
    .bind(&preview)
    .bind(&payload.body_text)
    .bind(&payload.body_html)
    .bind(&raw_mime)
    .bind(&in_reply_to_clean)
    .bind(&thread_id)
    .bind(has_attachments)
    .bind(&attachments_json)
    .execute(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
    })?;

    // 2. Deliver directly into inbox of any local tenant mailboxes (To, Cc, Bcc)
    for rcpt in &all_recipients {
        if rcpt.eq_ignore_ascii_case(&claims.email) {
            continue;
        }
        let local_rcpt = sqlx::query("SELECT tenant_id FROM mailboxes WHERE email = ?")
            .bind(rcpt)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();

        if let Some(rcpt_row) = local_rcpt {
            let rcpt_tid: String = rcpt_row.get("tenant_id");
            let inbox_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
            let _ = sqlx::query(
                r#"INSERT INTO mail_messages
                   (id, tenant_id, mailbox_email, folder, sender_name, sender_email, recipient_email, subject, preview, body_text, body_html, raw_mime, is_read, spf_dmarc_status, in_reply_to, thread_id, has_attachments, attachments)
                   VALUES (?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, 0, 'PASS (Internal DKIM)', ?, ?, ?, ?)"#,
            )
            .bind(&inbox_id)
            .bind(&rcpt_tid)
            .bind(rcpt)
            .bind(&claims.name)
            .bind(&claims.email)
            .bind(&recipient_summary)
            .bind(&payload.subject)
            .bind(&preview)
            .bind(&payload.body_text)
            .bind(&payload.body_html)
            .bind(&raw_mime)
            .bind(&in_reply_to_clean)
            .bind(&thread_id)
            .bind(has_attachments)
            .bind(&attachments_json)
            .execute(&state.db)
            .await;
        }
    }

    // 3. Multi-strategy Outbound Dispatch (Cloudflare REST -> Cloudflare SMTPS 465 -> Stalwart SMTP)
    let (injected, delivery_provider) = dispatch_outbound_email(
        &state.stalwart_smtp_addr,
        &state.cloudflare_ingress_secret,
        &claims.name,
        &claims.email,
        &to_emails,
        &cc_emails,
        &bcc_emails,
        &payload.subject,
        &payload.body_text,
        payload.body_html.as_deref(),
        &raw_mime,
        &attachments,
    )
    .await;

    // 4. Fire Extending Arm webhook event
    dispatch_tenant_event(
        &state.db,
        &claims.client_id,
        "mail.sent",
        serde_json::json!({
            "message_id": msg_id,
            "from": claims.email,
            "to": to_emails,
            "cc": cc_emails,
            "bcc": bcc_emails,
            "subject": payload.subject,
            "delivery_provider": delivery_provider
        }),
    )
    .await;

    Ok(Json(serde_json::json!({
        "status": if injected { "SENT" } else { "QUEUED_LOCALLY" },
        "message_id": msg_id,
        "from": claims.email,
        "to": to_emails,
        "cc": cc_emails,
        "bcc": bcc_emails,
        "recipient_summary": recipient_summary,
        "relayed_externally": injected,
        "stalwart_relayed": injected,
        "delivery_provider": delivery_provider
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

/// DELETE /api/umail/trash
/// Permanently purges all messages in the 'trash' folder for the authenticated mailbox
pub async fn empty_umail_trash_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let claims = extract_jwt_user(&headers, &state.jwt_secret)?;

    let result = sqlx::query("DELETE FROM mail_messages WHERE mailbox_email = ? AND folder = 'trash'")
        .bind(&claims.email)
        .execute(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
        })?;

    let purged_count = result.rows_affected();
    tracing::info!(
        "🗑️ Permanently emptied trash for mailbox {}: {} message(s) purged",
        claims.email,
        purged_count
    );

    Ok(Json(serde_json::json!({
        "status": "TRASH_EMPTIED",
        "mailbox": claims.email,
        "purged_count": purged_count
    })))
}

/// DELETE /api/umail/messages/:id
/// Permanently deletes a single message for the authenticated mailbox
pub async fn delete_umail_message(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(msg_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let claims = extract_jwt_user(&headers, &state.jwt_secret)?;

    let result = sqlx::query("DELETE FROM mail_messages WHERE mailbox_email = ? AND id = ?")
        .bind(&claims.email)
        .bind(&msg_id)
        .execute(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
        })?;

    Ok(Json(serde_json::json!({
        "status": "DELETED",
        "id": msg_id,
        "rows_affected": result.rows_affected()
    })))
}
