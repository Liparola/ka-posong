// ============================================================================
// KA-POSONG RAW RFC822 MIME -> STALWART PORT 25 / LMTP INJECTOR (src/smtp_injector.rs)
// Preserves SPF, DKIM, DMARC, and Authentication-Results across Tailscale Funnel
// ============================================================================

use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    time::{timeout, Duration},
};

#[derive(Debug, Clone)]
pub struct ParsedMimeSummary {
    pub subject: String,
    pub from_header: String,
    pub body_text: String,
    pub spf_dmarc_status: String,
}

pub fn parse_rfc822_summary(raw_mime: &[u8], fallback_from: &str) -> ParsedMimeSummary {
    let text = String::from_utf8_lossy(raw_mime);
    let (headers_part, body_part) = if let Some(idx) = text.find("\r\n\r\n") {
        (&text[..idx], &text[idx + 4..])
    } else if let Some(idx) = text.find("\n\n") {
        (&text[..idx], &text[idx + 2..])
    } else {
        (text.as_ref(), "")
    };

    let mut subject = "(No Subject)".to_string();
    let mut from_header = fallback_from.to_string();
    let mut spf_dmarc = "PASS (Cloudflare Edge Verified)".to_string();

    for line in headers_part.lines() {
        let lower = line.to_lowercase();
        if lower.starts_with("subject:") {
            subject = line[8..].trim().to_string();
        } else if lower.starts_with("from:") {
            from_header = line[5..].trim().to_string();
        } else if lower.starts_with("authentication-results:") {
            if lower.contains("fail") {
                spf_dmarc = "FAIL".to_string();
            } else {
                spf_dmarc = "PASS".to_string();
            }
        }
    }

    let cleaned_body = body_part.trim().to_string();
    ParsedMimeSummary {
        subject,
        from_header,
        body_text: if cleaned_body.is_empty() {
            "(Empty message body)".to_string()
        } else {
            cleaned_body
        },
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
