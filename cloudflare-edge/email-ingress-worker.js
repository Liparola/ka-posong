/**
 * ============================================================================
 * KA-POSONG BIDIRECTIONAL CLOUDFLARE EMAIL WORKER (Inbound + Outbound Bridge)
 * Liparola Multi-Tenant Mail Hosting Suite (liparola.org)
 * ============================================================================
 *
 * 1. INBOUND (`async email(message, env, ctx)`):
 *    Streams raw unaltered RFC 5322 MIME bytes from Cloudflare Email Routing
 *    over HTTPS to your local Tailscale Funnel (`/ingest-email`).
 *
 * 2. OUTBOUND (`async fetch(request, env, ctx)` — `POST /send-email`):
 *    Receives outbound emails from your local `ka-posong` Rust Control Plane
 *    over HTTPS Port 443 (bypassing ISP/VPN Port 25/587 blocks) and dispatches
 *    them via:
 *      • Cloudflare Native `send_email` Binding (`env.SEND_EMAIL`), OR
 *      • Resend HTTP API (`env.RESEND_API_KEY`), OR
 *      • Brevo HTTP API (`env.BREVO_API_KEY`).
 */

import { EmailMessage } from "cloudflare:email";

async function computeHmacSha256Hex(secret, messageBuffer) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, messageBuffer);
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default {
  // ==========================================================================
  // 1. INBOUND EMAIL HANDLER (Gmail/External -> Cloudflare -> Tailscale Funnel)
  // ==========================================================================
  async email(message, env, ctx) {
    const tunnelUrl =
      env.TAILSCALE_INGRESS_URL ||
      env.TUNNEL_INGEST_URL ||
      "https://aurum-thinkpad-t440p.tail8fafd0.ts.net/ingest-email";
    const bridgeSecret = env.BRIDGE_SECRET || "cf-tunnel-secret";

    try {
      const rawBuffer = await new Response(message.raw).arrayBuffer();
      const hmacSignature = await computeHmacSha256Hex(bridgeSecret, rawBuffer);

      const response = await fetch(tunnelUrl, {
        method: "POST",
        headers: {
          "Content-Type": "message/rfc822",
          "X-Bridge-Secret": bridgeSecret,
          "X-Ingress-HMAC-Signature": hmacSignature,
          "X-Envelope-From": message.from || "",
          "X-Envelope-To": message.to || "",
          "X-Message-Size": String(message.rawSize || rawBuffer.byteLength),
        },
        body: rawBuffer,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "Unknown error");
        message.setReject(`Temporary mail delivery error (${response.status}): ${errText}`);
      }
    } catch (err) {
      message.setReject("Temporary failure reaching mail ingress gateway.");
    }
  },

  // ==========================================================================
  // 2. OUTBOUND EMAIL HANDLER (uMail -> HTTPS Port 443 -> External Recipient)
  // ==========================================================================
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        status: "ok",
        worker: "kaposong-email-ingress",
        capabilities: ["inbound-mime-tunnel", "outbound-https-relay"],
        hasSendEmailBinding: Boolean(env.SEND_EMAIL),
        hasResendKey: Boolean(env.RESEND_API_KEY),
        hasBrevoKey: Boolean(env.BREVO_API_KEY),
      });
    }

    if (request.method !== "POST" || url.pathname !== "/send-email") {
      return Response.json({ error: "Use POST /send-email" }, { status: 404 });
    }

    const expectedSecret = env.BRIDGE_SECRET || "cf-tunnel-secret";
    const providedSecret = request.headers.get("X-Bridge-Secret") || "";
    if (providedSecret !== expectedSecret) {
      return Response.json({ error: "Unauthorized X-Bridge-Secret" }, { status: 401 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { from, from_name, to, subject, body_text, body_html, raw_mime } = payload;
    if (!from || !to || !raw_mime) {
      return Response.json(
        { error: "Missing required fields: from, to, raw_mime" },
        { status: 400 }
      );
    }

    // Strategy A: Cloudflare Email Sending Service Binding (env.EMAIL or env.SEND_EMAIL)
    const emailBinding = env.EMAIL || env.SEND_EMAIL;
    if (emailBinding && typeof emailBinding.send === "function") {
      // 1. Try structured object first (Cloudflare Email Sending Beta API)
      try {
        const sendOpts = {
          from,
          to,
          subject: subject || "(No Subject)",
          text: body_text || "",
        };
        if (body_html) sendOpts.html = body_html;

        const res = await emailBinding.send(sendOpts);
        return Response.json({
          status: "DISPATCHED",
          provider: "cloudflare-email-sending-binding",
          messageId: res?.messageId || res?.id || "cf-sent",
          from,
          to,
        });
      } catch (structuredErr) {
        // 2. Fallback to raw EmailMessage
        try {
          const msg = new EmailMessage(from, to, raw_mime);
          await emailBinding.send(msg);
          return Response.json({
            status: "DISPATCHED",
            provider: "cloudflare-send-email-mime-binding",
            from,
            to,
          });
        } catch (cfErr) {
          return Response.json(
            {
              error: `Cloudflare Email Binding failed: ${cfErr.message || String(cfErr)}`,
              structuredError: structuredErr.message || String(structuredErr),
            },
            { status: 502 }
          );
        }
      }
    }

    // Strategy B: Cloudflare Email Sending REST API (env.CLOUDFLARE_API_TOKEN)
    if (env.CLOUDFLARE_API_TOKEN) {
      const accountId = env.CLOUDFLARE_ACCOUNT_ID || "5d34290efd0db9537a45b9bb167f6e7f";
      const cfResp = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from,
            to,
            subject: subject || "(No Subject)",
            text: body_text || "",
            html: body_html || undefined,
          }),
        }
      );
      const cfData = await cfResp.json().catch(() => ({}));
      if (cfResp.ok && cfData.success !== false) {
        return Response.json({
          status: "DISPATCHED",
          provider: "cloudflare-email-sending-rest-api",
          ...cfData,
        });
      }
      return Response.json({ error: cfData }, { status: cfResp.status || 502 });
    }

    // Strategy B: Resend HTTPS API (`env.RESEND_API_KEY`)
    if (env.RESEND_API_KEY) {
      const rResp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: from_name ? `${from_name} <${from}>` : from,
          to: [to],
          subject: subject || "(No Subject)",
          text: body_text || "",
          html: body_html || undefined,
        }),
      });
      const rData = await rResp.json().catch(() => ({}));
      if (rResp.ok) {
        return Response.json({ status: "DISPATCHED", provider: "resend-edge", ...rData });
      }
      return Response.json({ error: rData }, { status: rResp.status });
    }

    // Strategy C: Brevo HTTPS API (`env.BREVO_API_KEY`)
    if (env.BREVO_API_KEY) {
      const bResp = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": env.BREVO_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sender: { name: from_name || from.split("@")[0], email: from },
          to: [{ email: to }],
          subject: subject || "(No Subject)",
          textContent: body_text || "",
          htmlContent: body_html || undefined,
        }),
      });
      const bData = await bResp.json().catch(() => ({}));
      if (bResp.ok) {
        return Response.json({ status: "DISPATCHED", provider: "brevo-edge", ...bData });
      }
      return Response.json({ error: bData }, { status: bResp.status });
    }

    return Response.json(
      {
        error:
          "No outbound binding configured on Worker yet. Add a 'Send email' binding named SEND_EMAIL (or RESEND_API_KEY / BREVO_API_KEY) in Cloudflare Worker Settings -> Bindings.",
      },
      { status: 501 }
    );
  },
};
