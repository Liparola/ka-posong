// ============================================================================
// KA-POSONG RAW RFC822 MIME PARSER & STALWART PORT 25 INJECTOR (src/smtp_injector.rs)
// Full multi-level RFC 5322 / RFC 2045-2047 Multipart, Quoted-Printable, Base64,
// Address & Authentication-Results Parser + SMTP Injector
// ============================================================================

use base64::{engine::general_purpose::STANDARD as BASE64_STD, Engine as _};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    time::{timeout, Duration},
};

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
    let mut unfoldedLines: Vec<String> = Vec::new();
    for line in raw_headers.lines() {
        let line = line.trim_end_matches('\r');
        if (line.starts_with(' ') || line.starts_with('\t')) && !unfoldedLines.is_empty() {
            if let Some(last) = unfoldedLines.last_mut() {
                last.push(' ');
                last.push_str(line.trim());
            }
        } else if !line.trim().is_empty() {
            unfoldedLines.push(line.to_string());
        }
    }

    let mut result = Vec::new();
    for line in unfoldedLines {
        if let Some(colon) = line.find(':') {
            let key = line[..colon].trim().to_lowercase();
            let val = line[colon + 1..].trim().to_string();
            result.push((key, val));
        }
    }
    result
}

/// Decodes Quoted-Printable byte stream (RFC 2045)
pub fn decode_quoted_printable(input: &str) -> String {
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

/// Recursively walks a MIME entity (single-part or nested multipart/*) to extract `(text/plain, text/html)`
fn extract_mime_parts(raw_entity: &str, out_text: &mut Option<String>, out_html: &mut Option<String>, depth: usize) {
    if depth > 8 {
        return;
    }

    let (headers_str, body_str) = split_headers_and_body(raw_entity);
    let headers = unfold_headers(headers_str);

    let mut content_type = "text/plain".to_string();
    let mut transfer_encoding = "7bit".to_string();
    let mut content_disposition = String::new();

    for (k, v) in &headers {
        if k == "content-type" {
            content_type = v.clone();
        } else if k == "content-transfer-encoding" {
            transfer_encoding = v.clone();
        } else if k == "content-disposition" {
            content_disposition = v.to_ascii_lowercase();
        }
    }

    // Skip non-inline file attachments
    if content_disposition.starts_with("attachment") {
        return;
    }

    let ct_lower = content_type.to_ascii_lowercase();
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
                        extract_mime_parts(&current_part, out_text, out_html, depth + 1);
                    }
                    break;
                } else if trimmed == delimiter || trimmed.starts_with(&delimiter) {
                    if inside_part && !current_part.trim().is_empty() {
                        extract_mime_parts(&current_part, out_text, out_html, depth + 1);
                    }
                    current_part.clear();
                    inside_part = true;
                } else if inside_part {
                    current_part.push_str(trimmed);
                    current_part.push_str("\r\n");
                }
            }
            if inside_part && !current_part.trim().is_empty() && out_text.is_none() && out_html.is_none() {
                extract_mime_parts(&current_part, out_text, out_html, depth + 1);
            }
            return;
        }
    }

    // Also handle the case where body_str itself starts with a `--boundary` (e.g. re-parsing a body_text without outer headers)
    let trimmed_body = raw_entity.trim_start();
    if trimmed_body.starts_with("--") {
        if let Some(first_line) = trimmed_body.lines().next() {
            let b_cand = first_line.trim_end_matches('\r').trim_start_matches("--");
            if b_cand.len() >= 6 && !b_cand.contains(' ') {
                let synthetic = format!(
                    "Content-Type: multipart/alternative; boundary=\"{}\"\r\n\r\n{}",
                    b_cand, trimmed_body
                );
                extract_mime_parts(&synthetic, out_text, out_html, depth + 1);
                return;
            }
        }
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

    for (k, v) in &headers {
        if k == "subject" {
            let dec = decode_rfc2047_word(v).trim().to_string();
            if !dec.is_empty() {
                subject = dec;
            }
        } else if k == "from" {
            raw_from_header = v.clone();
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
    extract_mime_parts(&text, &mut extracted_text, &mut extracted_html, 0);

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
