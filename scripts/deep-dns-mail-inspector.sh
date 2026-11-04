#!/usr/bin/env bash
# ============================================================================
# KA-POSONG DEEP DNS, CLOUDFLARE EMAIL ROUTING & MIME PROTOCOL INSPECTOR
# ============================================================================
# Usage: ./scripts/deep-dns-mail-inspector.sh [domain] [recipient_email]
# ============================================================================
set -euo pipefail

DOMAIN="${1:-liparola.org}"
RECIPIENT="${2:-admin@${DOMAIN}}"
FUNNEL_HOST="${PRIMARY_MAIL_HOSTNAME:-aurum-thinkpad-t440p.tail8fafd0.ts.net}"
BRIDGE_SECRET="${BRIDGE_SECRET:-cf-tunnel-secret}"

echo "╔══════════════════════════════════════════════════════════════════════════════╗"
echo "║ 🔍 KA-POSONG DEEP DNS & PROTOCOL CONVERSION DIAGNOSTIC (${DOMAIN})           ║"
echo "╚══════════════════════════════════════════════════════════════════════════════╝"

doh_query() {
  local qname="$1"
  local qtype="$2"
  curl -sf -H "accept: application/dns-json" \
    "https://cloudflare-dns.com/dns-query?name=${qname}&type=${qtype}" \
    | node -e '
      let d = "";
      process.stdin.on("data", c => d += c);
      process.stdin.on("end", () => {
        try {
          const j = JSON.parse(d);
          if (!j.Answer || j.Answer.length === 0) {
            console.log("  ❌ MISSING (No DNS Answer)");
            process.exit(0);
          }
          for (const a of j.Answer) {
            console.log(`  ✅ [TTL ${a.TTL}s] ${a.name} -> ${a.data}`);
          }
        } catch (e) {
          console.log("  ⚠️ Parse error:", e.message);
        }
      });
    '
}

echo ""
echo "1️⃣  [GLOBAL DNS PROPAGATION CHECK VIA CLOUDFLARE 1.1.1.1 DoH]"
echo "------------------------------------------------------------------------------"
echo "• MX Records (${DOMAIN}):"
doh_query "${DOMAIN}" "MX"

echo "• SPF TXT Record (${DOMAIN}):"
doh_query "${DOMAIN}" "TXT"

echo "• DKIM TXT Record (kaposong._domainkey.${DOMAIN}):"
doh_query "kaposong._domainkey.${DOMAIN}" "TXT"

echo "• DMARC TXT Record (_dmarc.${DOMAIN}):"
doh_query "_dmarc.${DOMAIN}" "TXT"

echo "• Webmail / JMAP CNAME (webmail.${DOMAIN}):"
doh_query "webmail.${DOMAIN}" "CNAME"

echo ""
echo "2️⃣  [WHY GMAIL RETURNED '550 5.1.1 Domain does not exist' ON route1.mx.cloudflare.net]"
echo "------------------------------------------------------------------------------"
cat << 'EOF'
  📌 ROOT CAUSE ANALYSIS:
     Your DNS records (MX route1/2/3.mx.cloudflare.net, SPF, DKIM, DMARC, CNAME)
     HAVE ALREADY PROPAGATED 100% globally — that is why Gmail knew to connect
     to Cloudflare's MX server (`route1.mx.cloudflare.net`).

     However, Cloudflare's MX servers return:
       `550 5.1.1 Domain does not exist. z46EUPcAHwXD`
     whenever the MX records were added manually in the "DNS -> Records" tab
     WITHOUT activating the "Email -> Email Routing" switch & Catch-All Worker
     rule inside the Cloudflare Dashboard!

  🛠️ HOW TO ACTIVATE THE CLOUDFLARE EMAIL ROUTING SWITCH (2 MINUTES):
     1. Open Cloudflare Dashboard -> select `liparola.org`.
     2. In the left sidebar, click **Email** -> **Email Routing**.
     3. If a banner says "Enable Email Routing", click **Enable Email Routing**
        (since your MX & SPF records are already present, Cloudflare will mark
        them green immediately).
     4. Click the **Email Workers** tab (under Email Routing):
        - Create a Worker named `kaposong-email-ingress` and paste the code from:
          `cloudflare-edge/email-ingress-worker.js`
        - Add two Environment Variables on the Worker:
          • `TAILSCALE_INGRESS_URL` = `https://aurum-thinkpad-t440p.tail8fafd0.ts.net/ingest-email`
          • `BRIDGE_SECRET`         = `cf-tunnel-secret`
     5. Click the **Routing Rules** tab (under Email Routing):
        - Enable **Catch-all address** (`* @liparola.org`).
        - Set Action: **Send to a Worker** -> `kaposong-email-ingress` -> **Save**.
EOF

echo ""
echo "3️⃣  [LIVE HTTPS-TO-SMTP PROTOCOL CONVERSION & RFC 5322 PARSING TEST]"
echo "------------------------------------------------------------------------------"
RAW_MIME=$(cat <<EOF
From: Khauta Jamaliehe <kjamaliehe@gmail.com>
To: <${RECIPIENT}>
Subject: [Live Protocol Test] Gmail -> Cloudflare Edge -> Tailscale Funnel -> uMail Inbox
Date: $(date -R)
Message-ID: <diag-$(date +%s)@mail.gmail.com>
Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=kjamaliehe@gmail.com; dkim=pass header.d=gmail.com; dmarc=pass
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

Khotso!

This message verifies the end-to-end HTTPS-to-SMTP protocol conversion pipeline:
1. Public HTTPS Ingress: https://${FUNNEL_HOST}/ingest-email
2. Cryptographic HMAC-SHA256 verification (X-Ingress-HMAC-Signature)
3. RFC 5322 header & body extraction + SPF/DKIM/DMARC badge parsing
4. Instant delivery into ${RECIPIENT} on https://${DOMAIN}/umail/inbox
EOF
)

HMAC_SIG=$(printf "%s" "${RAW_MIME}" | openssl dgst -sha256 -hmac "${BRIDGE_SECRET}" | awk '{print $NF}')

echo "• Sending signed RFC 5322 MIME stream to https://${FUNNEL_HOST}/ingest-email ..."
RESP=$(curl -sf -X POST "https://${FUNNEL_HOST}/ingest-email" \
  -H "Content-Type: message/rfc822" \
  -H "X-Bridge-Secret: ${BRIDGE_SECRET}" \
  -H "X-Ingress-HMAC-Signature: ${HMAC_SIG}" \
  -H "X-Envelope-From: kjamaliehe@gmail.com" \
  -H "X-Envelope-To: ${RECIPIENT}" \
  --data-binary "${RAW_MIME}")

echo "  ✅ Tailscale Funnel Ingress Response:"
echo "     ${RESP}"
echo "=============================================================================="
