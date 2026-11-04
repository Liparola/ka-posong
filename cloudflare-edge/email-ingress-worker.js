/**
 * ============================================================================
 * KA-POSONG CLOUDFLARE EMAIL ROUTING INGRESS WORKER (MIME -> HTTPS Tunnel)
 * Liparola Multi-Tenant Mail Hosting Suite
 * ============================================================================
 *
 * Streams raw unaltered RFC822 MIME bytes from Cloudflare Email Routing (Port 25)
 * over HTTPS to the Tailscale Funnel endpoint (`/ingest-email`) on your local
 * ka-posong Rust Control Plane, signed with a 256-bit HMAC-SHA256 signature
 * and Bridge Secret to preserve SPF, DKIM, and DMARC Authentication-Results.
 */

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
  async email(message, env, ctx) {
    const tunnelUrl =
      env.TAILSCALE_INGRESS_URL ||
      env.TUNNEL_INGEST_URL ||
      "https://aurum-thinkpad-t440p.tail8fafd0.ts.net/ingest-email";
    const bridgeSecret = env.BRIDGE_SECRET || "cf-tunnel-secret";

    try {
      // Read unaltered raw RFC822 MIME stream
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
        console.error(
          `[ka-posong-edge] Tunnel ingestion rejected (${response.status}): ${errText}`
        );
        message.setReject(
          `Temporary mail delivery error (${response.status}): ${errText}`
        );
      }
    } catch (err) {
      console.error(`[ka-posong-edge] Tunnel unreachable:`, err);
      message.setReject("Temporary failure reaching mail ingress gateway.");
    }
  },
};
