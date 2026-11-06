// ============================================================================
// KA-POSONG RAW RFC822 MIME PARSER & STALWART PORT 25 INJECTOR (src/smtp_injector.rs)
// Full multi-level RFC 5322 / RFC 2045-2047 Multipart, Quoted-Printable, Base64,
// Address & Authentication-Results Parser + SMTP Injector
// ============================================================================

use base64::{engine::general_purpose::STANDARD as BASE64_STD, Engine as _};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    time::{timeout, Duration},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentPayload {
    pub filename: String,
    pub content_type: String,
    pub content_base64: String,
    pub size_bytes: usize,
    #[serde(default)]
    pub cid: Option<String>,
    #[serde(default)]
    pub disposition: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ParsedMimeSummary {
    pub subject: String,
    pub sender_name: String,
    pub sender_email: String,
    pub from_header: String,
    pub body_text: String,
    pub body_html: Option<String>,
    pub preview: String,
    pub spf_dmarc_status: String,
    pub in_reply_to: Option<String>,
    pub message_id: Option<String>,
    pub references: Option<String>,
    pub attachments: Vec<AttachmentPayload>,
}

/// Splits headers and body from a raw RFC 5322 block
fn split_headers_and_body(raw: &str) -> (&str, &str) {
    if let Some(idx) = raw.find("\r\n\r\n") {
        (&raw[..idx], &raw[idx + 4..])
    } else if let Some(idx) = raw.find("\n\n") {
        (&raw[..idx], &raw[idx + 2..])
    } else {
        (raw, "")
    }
}

/// Unfolds RFC 5322 multi-line folded headers (lines starting with ' ' or '\t')
fn unfold_headers(raw_headers: &str) -> Vec<(String, String)> {
    let mut unfolded_lines: Vec<String> = Vec::new();
    for line in raw_headers.lines() {
        let line = line.trim_end_matches('\r');
        if (line.starts_with(' ') || line.starts_with('\t')) && !unfolded_lines.is_empty() {
            if let Some(last) = unfolded_lines.last_mut() {
                last.push(' ');
                last.push_str(line.trim());
            }
        } else if !line.trim().is_empty() {
            unfolded_lines.push(line.to_string());
        }
    }

    let mut result = Vec::new();
    for line in unfolded_lines {
        if let Some(colon) = line.find(':') {
            let key = line[..colon].trim().to_lowercase();
            let val = line[colon + 1..].trim().to_string();
            result.push((key, val));
        }
    }
    result
}

/// Decodes Quoted-Printable byte stream to raw bytes (RFC 2045)
pub fn decode_quoted_printable_bytes(input: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(input.len());
    let raw = input.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'=' {
            // Check soft line break `=\r\n` or `=\n`
            if i + 2 < raw.len() && raw[i + 1] == b'\r' && raw[i + 2] == b'\n' {
                i += 3;
                continue;
            }
            if i + 1 < raw.len() && raw[i + 1] == b'\n' {
                i += 2;
                continue;
            }
            if i + 2 < raw.len() {
                let h1 = raw[i + 1] as char;
                let h2 = raw[i + 2] as char;
                if let (Some(d1), Some(d2)) = (h1.to_digit(16), h2.to_digit(16)) {
                    bytes.push(((d1 << 4) | d2) as u8);
                    i += 3;
                    continue;
                }
            }
        }
        bytes.push(raw[i]);
        i += 1;
    }
    bytes
}

/// Decodes Quoted-Printable byte stream to UTF-8 lossy string (RFC 2045)
pub fn decode_quoted_printable(input: &str) -> String {
    let bytes = decode_quoted_printable_bytes(input);
    String::from_utf8_lossy(&bytes).to_string()
}

/// Decodes RFC 2047 encoded words `=?charset?encoding?text?=`
pub fn decode_rfc2047_word(input: &str) -> String {
    let mut out = String::new();
    let mut rest = input;
    while let Some(start) = rest.find("=?") {
        out.push_str(&rest[..start]);
        let after_start = &rest[start + 2..];
        let parts: Vec<&str> = after_start.splitn(4, '?').collect();
        if parts.len() == 4 {
            let enc = parts[1].to_ascii_uppercase();
            let encoded_text = parts[2];
            let tail = parts[3];
            if let Some(after_end) = tail.strip_prefix('=') {
                if enc == "B" {
                    let cleaned: String = encoded_text
                        .chars()
                        .filter(|c| !c.is_whitespace())
                        .collect();
                    if let Ok(decoded) = BASE64_STD.decode(cleaned.as_bytes()) {
                        out.push_str(&String::from_utf8_lossy(&decoded));
                        rest = after_end;
                        continue;
                    }
                } else if enc == "Q" {
                    let q_text = encoded_text.replace('_', " ");
                    out.push_str(&decode_quoted_printable(&q_text));
                    rest = after_end;
                    continue;
                }
            }
        }
        out.push_str("=?");
        rest = after_start;
    }
    out.push_str(rest);
    out
}

/// Parses an RFC 5322 From header like `"Khauta Maliehe" <kjamaliehe@gmail.com>` into `(name, email)`
pub fn parse_from_address(raw_from: &str, fallback_email: &str) -> (String, String) {
    let decoded = decode_rfc2047_word(raw_from).trim().to_string();
    if let (Some(lt), Some(gt)) = (decoded.find('<'), decoded.rfind('>')) {
        if lt < gt {
            let email_part = decoded[lt + 1..gt].trim().to_string();
            let name_part = decoded[..lt]
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .trim()
                .to_string();
            let final_email = if email_part.is_empty() {
                fallback_email.to_string()
            } else {
                email_part
            };
            let final_name = if name_part.is_empty() {
                final_email
                    .split('@')
                    .next()
                    .unwrap_or(&final_email)
                    .to_string()
            } else {
                name_part
            };
            return (final_name, final_email);
        }
    }

    let cleaned = decoded.trim_matches('"').trim().to_string();
    if cleaned.contains('@') && !cleaned.contains(' ') {
        let local = cleaned.split('@').next().unwrap_or(&cleaned).to_string();
        return (local, cleaned);
    }

    let fb = fallback_email.trim().to_string();
    let name = if cleaned.is_empty() {
        fb.split('@').next().unwrap_or("Sender").to_string()
    } else {
        cleaned
    };
    (name, fb)
}

/// Extracts `boundary="..."` parameter from a `Content-Type` header
fn extract_boundary(content_type: &str) -> Option<String> {
    for segment in content_type.split(';') {
        let trimmed = segment.trim();
        if trimmed.len() >= 9 && trimmed[..9].eq_ignore_ascii_case("boundary=") {
            let val = trimmed[9..].trim().trim_matches('"').trim_matches('\'');
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

/// Decodes a single MIME leaf body according to its `Content-Transfer-Encoding`
fn decode_transfer_encoding(body: &str, transfer_encoding: &str) -> String {
    let enc = transfer_encoding.trim().to_ascii_lowercase();
    if enc == "quoted-printable" {
        decode_quoted_printable(body)
    } else if enc == "base64" {
        let cleaned: String = body.chars().filter(|c| !c.is_whitespace()).collect();
        if let Ok(bytes) = BASE64_STD.decode(cleaned.as_bytes()) {
            String::from_utf8_lossy(&bytes).to_string()
        } else {
            body.trim().to_string()
        }
    } else {
        body.trim().to_string()
    }
}

/// Converts HTML into readable plain text when an email only provides `text/html`
pub fn html_to_plain_text(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut tag_buf = String::new();

    for ch in html.chars() {
        if ch == '<' {
            in_tag = true;
            tag_buf.clear();
        } else if ch == '>' && in_tag {
            in_tag = false;
            let t = tag_buf.trim().to_ascii_lowercase();
            if t.starts_with("br")
                || t.starts_with("/p")
                || t.starts_with("/div")
                || t.starts_with("/tr")
                || t.starts_with("/li")
            {
                text.push('\n');
            }
        } else if in_tag {
            tag_buf.push(ch);
        } else {
            text.push(ch);
        }
    }

    let decoded = text
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");

    // Collapse excessive blank lines
    let mut lines: Vec<&str> = Vec::new();
    let mut blank_run = 0;
    for line in decoded.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            blank_run += 1;
            if blank_run <= 2 {
                lines.push("");
            }
        } else {
            blank_run = 0;
            lines.push(trimmed);
        }
    }
    lines.join("\n").trim().to_string()
}

/// Extracts filename parameter from Content-Disposition or Content-Type headers
fn extract_filename_from_headers(headers: &[(String, String)]) -> Option<String> {
    for (k, v) in headers {
        if k == "content-disposition" || k == "content-type" {
            for segment in v.split(';') {
                let trimmed = segment.trim();
                let lower = trimmed.to_ascii_lowercase();
                if lower.starts_with("filename*=") {
                    let val = trimmed[10..].trim();
                    let decoded = if let Some(idx) = val.find("''") {
                        let enc_part = &val[idx + 2..];
                        decode_rfc2047_word(enc_part)
                    } else {
                        val.trim_matches('"').trim_matches('\'').to_string()
                    };
                    if !decoded.is_empty() {
                        return Some(decoded);
                    }
                } else if lower.starts_with("filename=") {
                    let val = trimmed[9..].trim().trim_matches('"').trim_matches('\'');
                    if !val.is_empty() {
                        return Some(decode_rfc2047_word(val));
                    }
                } else if lower.starts_with("name=") {
                    let val = trimmed[5..].trim().trim_matches('"').trim_matches('\'');
                    if !val.is_empty() {
                        return Some(decode_rfc2047_word(val));
                    }
                }
            }
        }
    }
    None
}

/// Sanitizes attachment filename to prevent path traversal or special control chars
pub fn sanitize_attachment_filename(name: &str, default_ext: &str) -> String {
    let clean: String = name
        .chars()
        .filter(|c| !c.is_control() && *c != '/' && *c != '\\' && *c != '\0' && *c != '\"' && *c != '\'')
        .collect();
    let trimmed = clean.trim();
    if trimmed.is_empty() {
        format!("attachment_{}.{}", uuid::Uuid::new_v4().simple(), default_ext)
    } else if trimmed.len() > 180 {
        trimmed[..180].to_string()
    } else {
        trimmed.to_string()
    }
}

/// Chunks Base64 into RFC 2045 compliant 76-character lines with \r\n linebreaks
pub fn wrap_base64_76(input: &str) -> String {
    let cleaned: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    let mut out = String::with_capacity(cleaned.len() + (cleaned.len() / 76 + 1) * 2);
    for chunk in cleaned.as_bytes().chunks(76) {
        if let Ok(s) = std::str::from_utf8(chunk) {
            out.push_str(s);
            out.push_str("\r\n");
        }
    }
    out
}

/// Parses raw comma/semicolon-separated recipients into clean lowercase email addresses
pub fn parse_recipient_list(raw: &str) -> Vec<String> {
    let mut result = Vec::new();
    for part in raw.split([',', ';']) {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        let email = if let (Some(lt), Some(gt)) = (trimmed.find('<'), trimmed.rfind('>')) {
            if lt < gt {
                trimmed[lt + 1..gt].trim().to_lowercase()
            } else {
                trimmed.to_lowercase()
            }
        } else {
            trimmed.trim_matches('"').trim_matches('\'').trim().to_lowercase()
        };
        if email.contains('@') && !email.contains(' ') && !result.contains(&email) {
            result.push(email);
        }
    }
    result
}

/// Builds a standards-compliant RFC 5322 MIME message supporting multiple To recipients, Cc recipients, HTML, and file attachments
pub fn build_multipart_mime(
    from_name: &str,
    from_email: &str,
    to_emails: &[String],
    cc_emails: &[String],
    subject: &str,
    body_text: &str,
    body_html: Option<&str>,
    in_reply_to: Option<&str>,
    references: Option<&str>,
    attachments: &[AttachmentPayload],
) -> String {
    let now_rfc2822 = chrono::Utc::now().to_rfc2822();
    let msg_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    let domain = from_email.split('@').nth(1).unwrap_or("liparola.org");

    let formatted_to = if to_emails.is_empty() {
        "<undisclosed-recipients:;>".to_string()
    } else {
        to_emails
            .iter()
            .map(|e| format!("<{}>", e.trim()))
            .collect::<Vec<_>>()
            .join(", ")
    };

    let mut headers = format!(
        "From: {} <{}>\r\nTo: {}\r\nSubject: {}\r\nDate: {}\r\nMessage-ID: <{}@{}>\r\nMIME-Version: 1.0\r\n",
        from_name, from_email, formatted_to, subject, now_rfc2822, msg_id, domain
    );

    if !cc_emails.is_empty() {
        let formatted_cc = cc_emails
            .iter()
            .map(|e| format!("<{}>", e.trim()))
            .collect::<Vec<_>>()
            .join(", ");
        headers.push_str(&format!("Cc: {}\r\n", formatted_cc));
    }

    if let Some(ir) = in_reply_to {
        let clean = ir.trim().trim_matches('<').trim_matches('>');
        if !clean.is_empty() {
            headers.push_str(&format!("In-Reply-To: <{}>\r\n", clean));
        }
    }
    if let Some(rf) = references {
        let clean = rf.trim();
        if !clean.is_empty() {
            headers.push_str(&format!("References: {}\r\n", clean));
        }
    }

    if attachments.is_empty() {
        if let Some(html) = body_html {
            if !html.trim().is_empty() {
                let alt_boundary = format!("----=_Part_alt_{}", uuid::Uuid::new_v4().simple());
                headers.push_str(&format!(
                    "Content-Type: multipart/alternative; boundary=\"{}\"\r\n\r\n",
                    alt_boundary
                ));
                let body = format!(
                    "--{}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n{}\r\n\r\n--{}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n{}\r\n\r\n--{}--\r\n",
                    alt_boundary, body_text, alt_boundary, html, alt_boundary
                );
                return format!("{}{}", headers, body);
            }
        }
        headers.push_str("Content-Type: text/plain; charset=utf-8; format=flowed\r\nContent-Transfer-Encoding: 8bit\r\n\r\n");
        return format!("{}{}", headers, body_text);
    }

    // Attachments present -> multipart/mixed envelope
    let mixed_boundary = format!("----=_Part_mixed_{}", uuid::Uuid::new_v4().simple());
    headers.push_str(&format!(
        "Content-Type: multipart/mixed; boundary=\"{}\"\r\n\r\n",
        mixed_boundary
    ));

    let mut mime_body = String::new();

    // 1. Text/HTML alternative or plain text part
    mime_body.push_str(&format!("--{}\r\n", mixed_boundary));
    if let Some(html) = body_html {
        if !html.trim().is_empty() {
            let alt_boundary = format!("----=_Part_alt_{}", uuid::Uuid::new_v4().simple());
            mime_body.push_str(&format!(
                "Content-Type: multipart/alternative; boundary=\"{}\"\r\n\r\n",
                alt_boundary
            ));
            mime_body.push_str(&format!(
                "--{}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n{}\r\n\r\n--{}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n{}\r\n\r\n--{}--\r\n\r\n",
                alt_boundary, body_text, alt_boundary, html, alt_boundary
            ));
        } else {
            mime_body.push_str("Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n");
            mime_body.push_str(body_text);
            mime_body.push_str("\r\n\r\n");
        }
    } else {
        mime_body.push_str("Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n");
        mime_body.push_str(body_text);
        mime_body.push_str("\r\n\r\n");
    }

    // 2. File attachment parts
    for att in attachments {
        let filename = sanitize_attachment_filename(&att.filename, "bin");
        let disposition = att.disposition.as_deref().unwrap_or("attachment");
        let content_type = if att.content_type.trim().is_empty() {
            "application/octet-stream"
        } else {
            att.content_type.trim()
        };

        mime_body.push_str(&format!("--{}\r\n", mixed_boundary));
        mime_body.push_str(&format!(
            "Content-Type: {}; name=\"{}\"\r\nContent-Disposition: {}; filename=\"{}\"\r\n",
            content_type, filename, disposition, filename
        ));
        if let Some(ref cid) = att.cid {
            let clean_cid = cid.trim().trim_matches('<').trim_matches('>');
            if !clean_cid.is_empty() {
                mime_body.push_str(&format!("Content-ID: <{}>\r\n", clean_cid));
            }
        }
        mime_body.push_str("Content-Transfer-Encoding: base64\r\n\r\n");
        mime_body.push_str(&wrap_base64_76(&att.content_base64));
        mime_body.push_str("\r\n\r\n");
    }

    mime_body.push_str(&format!("--{}--\r\n", mixed_boundary));

    format!("{}{}", headers, mime_body)
}

/// Recursively walks a MIME entity (single-part or nested multipart/*) to extract `(text/plain, text/html, attachments)`
fn extract_mime_parts(
    raw_entity: &str,
    out_text: &mut Option<String>,
    out_html: &mut Option<String>,
    out_attachments: &mut Vec<AttachmentPayload>,
    depth: usize,
) {
    if depth > 8 {
        return;
    }

    let (headers_str, body_str) = split_headers_and_body(raw_entity);
    let headers = unfold_headers(headers_str);

    let mut content_type = "text/plain".to_string();
    let mut transfer_encoding = "7bit".to_string();
    let mut content_disposition = String::new();
    let mut content_id: Option<String> = None;

    for (k, v) in &headers {
        if k == "content-type" {
            content_type = v.clone();
        } else if k == "content-transfer-encoding" {
            transfer_encoding = v.clone();
        } else if k == "content-disposition" {
            content_disposition = v.to_ascii_lowercase();
        } else if k == "content-id" {
            let cid = v.trim().trim_matches('<').trim_matches('>').trim().to_string();
            if !cid.is_empty() {
                content_id = Some(cid);
            }
        }
    }

    let ct_lower = content_type.to_ascii_lowercase();

    // Check if multipart container
    if ct_lower.starts_with("multipart/") {
        if let Some(boundary) = extract_boundary(&content_type) {
            let delimiter = format!("--{}", boundary);
            let end_delimiter = format!("--{}--", boundary);
            let mut current_part = String::new();
            let mut inside_part = false;

            for line in body_str.lines() {
                let trimmed = line.trim_end_matches('\r');
                if trimmed == end_delimiter || trimmed.starts_with(&end_delimiter) {
                    if inside_part && !current_part.trim().is_empty() {
                        extract_mime_parts(&current_part, out_text, out_html, out_attachments, depth + 1);
                    }
                    break;
                } else if trimmed == delimiter || trimmed.starts_with(&delimiter) {
                    if inside_part && !current_part.trim().is_empty() {
                        extract_mime_parts(&current_part, out_text, out_html, out_attachments, depth + 1);
                    }
                    current_part.clear();
                    inside_part = true;
                } else if inside_part {
                    current_part.push_str(trimmed);
                    current_part.push_str("\r\n");
                }
            }
            if inside_part && !current_part.trim().is_empty() {
                extract_mime_parts(&current_part, out_text, out_html, out_attachments, depth + 1);
            }
            return;
        }
    }

    // Check if body starts with a boundary token without explicit Content-Type header
    let trimmed_body = raw_entity.trim_start();
    if trimmed_body.starts_with("--") {
        if let Some(first_line) = trimmed_body.lines().next() {
            let b_cand = first_line.trim_end_matches('\r').trim_start_matches("--");
            if b_cand.len() >= 6 && !b_cand.contains(' ') {
                let synthetic = format!(
                    "Content-Type: multipart/alternative; boundary=\"{}\"\r\n\r\n{}",
                    b_cand, trimmed_body
                );
                extract_mime_parts(&synthetic, out_text, out_html, out_attachments, depth + 1);
                return;
            }
        }
    }

    // Detect if this part is an attachment or inline asset
    let filename_opt = extract_filename_from_headers(&headers);
    let is_explicit_attachment = content_disposition.starts_with("attachment") || filename_opt.is_some();
    let is_inline_media = (content_disposition.starts_with("inline") || content_id.is_some()) && !ct_lower.starts_with("text/");
    let is_non_text_payload = !ct_lower.starts_with("text/") && !ct_lower.starts_with("multipart/");

    if is_explicit_attachment || is_inline_media || is_non_text_payload {
        let enc_lower = transfer_encoding.trim().to_ascii_lowercase();
        let (content_b64, size_bytes) = if enc_lower == "base64" {
            let cleaned: String = body_str.chars().filter(|c| !c.is_whitespace()).collect();
            let size = (cleaned.len() * 3) / 4;
            (cleaned, size)
        } else if enc_lower == "quoted-printable" {
            let decoded_bytes = decode_quoted_printable_bytes(body_str);
            let size = decoded_bytes.len();
            (BASE64_STD.encode(&decoded_bytes), size)
        } else {
            let bytes = body_str.as_bytes();
            (BASE64_STD.encode(bytes), bytes.len())
        };

        let pure_type = content_type.split(';').next().unwrap_or("application/octet-stream").trim().to_string();
        let filename = filename_opt.unwrap_or_else(|| {
            let ext = pure_type.split('/').nth(1).unwrap_or("bin");
            format!("attachment_{}.{}", out_attachments.len() + 1, ext)
        });

        out_attachments.push(AttachmentPayload {
            filename: sanitize_attachment_filename(&filename, "bin"),
            content_type: pure_type,
            content_base64: content_b64,
            size_bytes,
            cid: content_id,
            disposition: Some(if content_disposition.starts_with("inline") { "inline".to_string() } else { "attachment".to_string() }),
        });
        return;
    }

    let decoded = decode_transfer_encoding(body_str, &transfer_encoding);
    if ct_lower.starts_with("text/html") {
        if out_html.is_none() && !decoded.trim().is_empty() {
            *out_html = Some(decoded);
        }
    } else if ct_lower.starts_with("text/plain") {
        if out_text.is_none() && !decoded.trim().is_empty() {
            *out_text = Some(decoded);
        }
    }
}

pub fn parse_rfc822_summary(raw_mime: &[u8], fallback_from: &str) -> ParsedMimeSummary {
    let text = String::from_utf8_lossy(raw_mime);
    let (headers_part, _) = split_headers_and_body(&text);
    let headers = unfold_headers(headers_part);

    let mut subject = "(No Subject)".to_string();
    let mut raw_from_header = fallback_from.to_string();
    let mut spf_dmarc = "PASS (DKIM+SPF)".to_string();
    let mut in_reply_to: Option<String> = None;
    let mut message_id: Option<String> = None;
    let mut references: Option<String> = None;

    for (k, v) in &headers {
        if k == "subject" {
            let dec = decode_rfc2047_word(v).trim().to_string();
            if !dec.is_empty() {
                subject = dec;
            }
        } else if k == "from" {
            raw_from_header = v.clone();
        } else if k == "in-reply-to" {
            let cleaned = v.trim().trim_matches('<').trim_matches('>').trim().to_string();
            if !cleaned.is_empty() {
                in_reply_to = Some(cleaned);
            }
        } else if k == "message-id" {
            let cleaned = v.trim().trim_matches('<').trim_matches('>').trim().to_string();
            if !cleaned.is_empty() {
                message_id = Some(cleaned);
            }
        } else if k == "references" {
            let cleaned = v.trim().to_string();
            if !cleaned.is_empty() {
                references = Some(cleaned);
            }
        } else if k == "authentication-results" {
            let lower = v.to_ascii_lowercase();
            let spf_ok = lower.contains("spf=pass");
            let dkim_ok = lower.contains("dkim=pass");
            let dmarc_ok = lower.contains("dmarc=pass");
            if lower.contains("spf=fail") || lower.contains("dmarc=fail") {
                spf_dmarc = "FAIL (Auth Check)".to_string();
            } else if spf_ok && dkim_ok && dmarc_ok {
                spf_dmarc = "PASS (SPF+DKIM+DMARC)".to_string();
            } else if spf_ok && dkim_ok {
                spf_dmarc = "PASS (DKIM+SPF)".to_string();
            } else if spf_ok {
                spf_dmarc = "PASS (SPF)".to_string();
            } else {
                spf_dmarc = "PASS".to_string();
            }
        }
    }

    let (sender_name, sender_email) = parse_from_address(&raw_from_header, fallback_from);

    let mut extracted_text: Option<String> = None;
    let mut extracted_html: Option<String> = None;
    let mut attachments: Vec<AttachmentPayload> = Vec::new();
    extract_mime_parts(&text, &mut extracted_text, &mut extracted_html, &mut attachments, 0);

    let body_text = match (&extracted_text, &extracted_html) {
        (Some(t), _) if !t.trim().is_empty() => t.trim().to_string(),
        (_, Some(h)) if !h.trim().is_empty() => html_to_plain_text(h),
        _ => {
            let (_, fallback_body) = split_headers_and_body(&text);
            let trimmed = fallback_body.trim();
            if trimmed.is_empty() {
                "(Empty message body)".to_string()
            } else {
                trimmed.to_string()
            }
        }
    };

    // Build single-line clean preview snippet (max 140 chars)
    let preview_single_line: String = body_text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('>'))
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(140)
        .collect();

    let preview = if preview_single_line.is_empty() {
        body_text.chars().take(120).collect()
    } else {
        preview_single_line
    };

    ParsedMimeSummary {
        subject,
        sender_name: sender_name.clone(),
        sender_email,
        from_header: sender_name,
        body_text,
        body_html: extracted_html,
        preview,
        spf_dmarc_status: spf_dmarc,
        in_reply_to,
        message_id,
        references,
        attachments,
    }
}

pub async fn inject_smtp_to_stalwart(
    addr: &str,
    from: &str,
    to: &str,
    raw_mime: &[u8],
) -> Result<bool, String> {
    let connect_fut = TcpStream::connect(addr);
    let stream = match timeout(Duration::from_secs(3), connect_fut).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            tracing::warn!(
                "[SMTP Injector] Stalwart SMTP port {} unreachable ({}); message persisted in Control Plane inbox store",
                addr,
                e
            );
            return Ok(false);
        }
        Err(_) => {
            tracing::warn!(
                "[SMTP Injector] Timeout connecting to Stalwart SMTP {}; message persisted in Control Plane inbox store",
                addr
            );
            return Ok(false);
        }
    };

    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut line = String::new();

    reader
        .read_line(&mut line)
        .await
        .map_err(|e| e.to_string())?;
    writer
        .write_all(b"EHLO rust-control-plane.internal\r\n")
        .await
        .map_err(|e| e.to_string())?;

    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .await
            .map_err(|e| e.to_string())?;
        if n == 0 || line.starts_with("250 ") {
            break;
        }
    }

    writer
        .write_all(format!("MAIL FROM:<{}>\r\n", from).as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    line.clear();
    reader
        .read_line(&mut line)
        .await
        .map_err(|e| e.to_string())?;

    writer
        .write_all(format!("RCPT TO:<{}>\r\n", to).as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    line.clear();
    reader
        .read_line(&mut line)
        .await
        .map_err(|e| e.to_string())?;

    writer
        .write_all(b"DATA\r\n")
        .await
        .map_err(|e| e.to_string())?;
    line.clear();
    reader
        .read_line(&mut line)
        .await
        .map_err(|e| e.to_string())?;

    writer.write_all(raw_mime).await.map_err(|e| e.to_string())?;
    writer
        .write_all(b"\r\n.\r\n")
        .await
        .map_err(|e| e.to_string())?;
    line.clear();
    reader
        .read_line(&mut line)
        .await
        .map_err(|e| e.to_string())?;

    writer
        .write_all(b"QUIT\r\n")
        .await
        .map_err(|e| e.to_string())?;

    Ok(true)
}

/// Multi-Strategy Outbound Email Dispatcher (HTTPS Port 443 Edge Relay + SMTPS Port 465 + Stalwart SMTP Relay)
/// Supports multiple To recipients, Cc (Carbon Copy), Bcc (Blind Carbon Copy) and up to 120MB attachments
pub async fn dispatch_outbound_email(
    stalwart_smtp_addr: &str,
    bridge_secret: &str,
    from_name: &str,
    from_email: &str,
    to_emails: &[String],
    cc_emails: &[String],
    bcc_emails: &[String],
    subject: &str,
    body_text: &str,
    body_html: Option<&str>,
    raw_mime: &str,
    attachments: &[AttachmentPayload],
) -> (bool, String) {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default();

    let mut all_envelope_rcpts: Vec<String> = Vec::new();
    for email in to_emails.iter().chain(cc_emails.iter()).chain(bcc_emails.iter()) {
        let clean = email.trim().to_lowercase();
        if !clean.is_empty() && !all_envelope_rcpts.contains(&clean) {
            all_envelope_rcpts.push(clean);
        }
    }

    if all_envelope_rcpts.is_empty() {
        return (false, "no-recipients-provided".to_string());
    }

    let primary_rcpt = to_emails.first().cloned().unwrap_or_else(|| all_envelope_rcpts[0].clone());
    let total_attachment_bytes: usize = attachments.iter().map(|a| a.size_bytes).sum();
    // Cloudflare REST API (Beta) is best suited for simple single-recipient text/HTML messages.
    // When Cc/Bcc are present, multiple To exist, attachments exist, or payloads > 20MB (up to 120MB),
    // route directly via Cloudflare SMTPS (Port 465) for full standard RFC 5321/5322 compliance.
    let prefer_direct_smtps = !attachments.is_empty()
        || !cc_emails.is_empty()
        || !bcc_emails.is_empty()
        || to_emails.len() > 1
        || total_attachment_bytes > 20 * 1024 * 1024;

    // Strategy 1: Cloudflare Email Sending Service (REST API or SMTPS 465)
    if let Ok(cf_token) = std::env::var("CLOUDFLARE_API_TOKEN") {
        let cf_token = cf_token.trim();
        if !cf_token.is_empty() {
            let cf_account = std::env::var("CLOUDFLARE_ACCOUNT_ID")
                .unwrap_or_else(|_| "5d34290efd0db9537a45b9bb167f6e7f".to_string());

            // Strategy 1A: REST API (for lightweight messages without attachments & single recipient)
            if !prefer_direct_smtps {
                let endpoint = format!(
                    "https://api.cloudflare.com/client/v4/accounts/{}/email/sending/send",
                    cf_account.trim()
                );

                let mut req_body = serde_json::json!({
                    "from": from_email,
                    "to": primary_rcpt,
                    "subject": subject,
                    "text": body_text,
                });
                if let Some(html) = body_html {
                    if !html.is_empty() {
                        req_body["html"] = serde_json::Value::String(html.to_string());
                    }
                }

                match client
                    .post(&endpoint)
                    .bearer_auth(cf_token)
                    .header("Content-Type", "application/json")
                    .json(&req_body)
                    .send()
                    .await
                {
                    Ok(resp) => {
                        let status = resp.status();
                        let resp_txt = resp.text().await.unwrap_or_default();
                        if status.is_success() {
                            tracing::info!(
                                "✅ Outbound dispatched via Cloudflare Email Sending REST API ({} attachments, {} bytes): {}",
                                attachments.len(),
                                total_attachment_bytes,
                                resp_txt
                            );
                            return (true, "cloudflare-email-sending-rest-api".to_string());
                        } else {
                            tracing::warn!(
                                "⚠️ Cloudflare Email Sending REST API returned {}: {}. Failing over to Cloudflare SMTPS (Port 465)...",
                                status,
                                resp_txt
                            );
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            "⚠️ Cloudflare Email Sending REST API error: {}. Failing over to Cloudflare SMTPS (Port 465)...",
                            e
                        );
                    }
                }
            }

            // Strategy 1B: Cloudflare SMTPS (Implicit TLS Port 465)
            // Supports multiple To, Cc, Bcc, and large raw RFC 5322 MIME messages up to 120MB streaming
            tracing::info!(
                "🚀 Dispatching outbound RFC 5322 MIME envelope via Cloudflare SMTPS (Port 465) to {} recipient(s) [To: {}, Cc: {}, Bcc: {}] (attachments: {}, total bytes: {})...",
                all_envelope_rcpts.len(),
                to_emails.len(),
                cc_emails.len(),
                bcc_emails.len(),
                attachments.len(),
                total_attachment_bytes
            );

            let mut curl_cmd = tokio::process::Command::new("curl");
            curl_cmd
                .arg("-sS")
                .arg("--ssl-reqd")
                .arg("--url")
                .arg("smtps://smtp.mx.cloudflare.net:465")
                .arg("--user")
                .arg(format!("api_token:{}", cf_token))
                .arg("--mail-from")
                .arg(from_email);

            for rcpt in &all_envelope_rcpts {
                curl_cmd.arg("--mail-rcpt").arg(rcpt);
            }

            curl_cmd
                .arg("-T")
                .arg("-")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());

            if let Ok(mut child) = curl_cmd.spawn() {
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(raw_mime.as_bytes()).await;
                }
                if let Ok(output) = child.wait_with_output().await {
                    if output.status.success() {
                        tracing::info!(
                            "✅ Outbound successfully delivered via Cloudflare SMTPS (Port 465) to {} recipient(s) ({} attachments)",
                            all_envelope_rcpts.len(),
                            attachments.len()
                        );
                        return (true, "cloudflare-smtps-port465".to_string());
                    } else {
                        let err_msg = String::from_utf8_lossy(&output.stderr);
                        tracing::warn!(
                            "⚠️ Cloudflare SMTPS (Port 465) returned {}: {}",
                            output.status,
                            err_msg.trim()
                        );
                    }
                }
            }
        }
    }

    // Strategy 2: Cloudflare Bidirectional Email Worker (`OUTBOUND_WORKER_URL` or `CLOUDFLARE_OUTBOUND_WORKER_URL`)
    let worker_url = std::env::var("OUTBOUND_WORKER_URL")
        .or_else(|_| std::env::var("CLOUDFLARE_OUTBOUND_WORKER_URL"))
        .ok();
    if let Some(cf_url) = worker_url {
        let cf_url = cf_url.trim();
        if !cf_url.is_empty() {
            let endpoint = if cf_url.ends_with("/send-email") {
                cf_url.to_string()
            } else {
                format!("{}/send-email", cf_url.trim_end_matches('/'))
            };
            if let Ok(resp) = client
                .post(&endpoint)
                .header("X-Bridge-Secret", bridge_secret)
                .json(&serde_json::json!({
                    "from": from_email,
                    "from_name": from_name,
                    "to": primary_rcpt,
                    "all_recipients": all_envelope_rcpts,
                    "subject": subject,
                    "body_text": body_text,
                    "body_html": body_html,
                    "raw_mime": raw_mime,
                }))
                .send()
                .await
            {
                if resp.status().is_success() {
                    return (true, "cloudflare-worker-https".to_string());
                }
            }
        }
    }

    // Strategy 3: Direct Resend HTTPS API (`RESEND_API_KEY`) over Port 443
    if let Ok(resend_key) = std::env::var("RESEND_API_KEY") {
        let resend_key = resend_key.trim();
        if !resend_key.is_empty() {
            let mut resend_payload = serde_json::json!({
                "from": format!("{} <{}>", from_name, from_email),
                "to": to_emails,
                "subject": subject,
                "text": body_text,
                "html": body_html,
            });
            if !cc_emails.is_empty() {
                resend_payload["cc"] = serde_json::json!(cc_emails);
            }
            if !bcc_emails.is_empty() {
                resend_payload["bcc"] = serde_json::json!(bcc_emails);
            }
            if let Ok(resp) = client
                .post("https://api.resend.com/emails")
                .bearer_auth(resend_key)
                .json(&resend_payload)
                .send()
                .await
            {
                if resp.status().is_success() {
                    return (true, "resend-https-api".to_string());
                }
            }
        }
    }

    // Strategy 4: Local Stalwart / Smart Host SMTP Injection
    let mut any_ok = false;
    for rcpt in &all_envelope_rcpts {
        if let Ok(true) = inject_smtp_to_stalwart(
            stalwart_smtp_addr,
            from_email,
            rcpt,
            raw_mime.as_bytes(),
        )
        .await {
            any_ok = true;
        }
    }

    if any_ok {
        (true, "stalwart-smtp".to_string())
    } else {
        (false, "local-sent-store".to_string())
    }
}
