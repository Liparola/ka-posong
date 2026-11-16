#!/usr/bin/env bash
# ============================================================================
# KA-POSONG CLIENT DOMAIN ONBOARDING & CLOUDFLARE BIND ZONE GENERATOR
#
# Usage:
#   ./scripts/onboard-client-domain.sh "<ORG_NAME>" <DOMAIN> <TIER> <ADMIN_USER> [ADMIN_PHONE] \
#       [--mailbox <local_part>:<phone>]... [--web-dir </path/to/website>]
#
# Example (Karabo Milling):
#   ./scripts/onboard-client-domain.sh "Karabo Milling (Pty) Ltd" karabomilling.co.ls ENTERPRISE info +26653872233 \
#       --mailbox linka:+26663483311 \
#       --web-dir /home/aurum/Documents/karabomilling.co.ls
#
# Outputs:
#   1. ./domains/<DOMAIN>.txt              (Cloudflare BIND Zone import file matching liparola.org (1).txt)
#   2. ./domains/<DOMAIN>-DNS-SETUP.txt    (Human + JSON DNS & onboarding summary)
#   3. <WEB_DIR>/public/umail/*            (Optional: Custom-built uMail PWA for Firebase Hosting)
# ============================================================================
set -euo pipefail

if [ "$#" -lt 4 ]; then
    echo "Usage: $0 \"<ORG_NAME>\" <DOMAIN> <TIER: STARTER|GROWTH|ENTERPRISE> <ADMIN_USER> [ADMIN_PHONE] [--mailbox user:phone]... [--web-dir /path/to/site]"
    exit 1
fi

ORG_NAME="$1"
DOMAIN="$2"
TIER="$(echo "$3" | tr '[:lower:]' '[:upper:]')"
ADMIN_USER="$4"
shift 4

ADMIN_PHONE="+26657284264"
if [ "$#" -gt 0 ] && [[ ! "$1" =~ ^-- ]]; then
    ADMIN_PHONE="$1"
    shift 1
fi

# Normalize phone helper (prepends +266 if 8 digits)
normalize_phone() {
    local raw="$1"
    local digits="${raw//[^0-9]/}"
    if [ "${#digits}" -eq 8 ]; then
        echo "+266${digits}"
    elif [[ "$raw" =~ ^\+ ]]; then
        echo "$raw"
    else
        echo "+${digits}"
    fi
}

ADMIN_PHONE="$(normalize_phone "$ADMIN_PHONE")"

EXTRA_MAILBOXES=()
WEB_DIR=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --mailbox)
            EXTRA_MAILBOXES+=("$2")
            shift 2
            ;;
        --web-dir)
            WEB_DIR="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT_DIR/domains"

if [ -f "$ROOT_DIR/.env" ]; then
    # shellcheck disable=SC1091
    source "$ROOT_DIR/.env"
fi

API_URL="${CONTROL_PLANE_URL:-http://127.0.0.1:8443}"
MASTER_KEY="${MASTER_DEVOPS_KEY:-devops-master-key}"

echo "🌐 [1/5] Provisioning tenant '${ORG_NAME}' (${DOMAIN}) on tier ${TIER}..."

RESPONSE=$(curl -sS -X POST "${API_URL}/api/v1/admin/tenants" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: ${MASTER_KEY}" \
    -d "{
        \"organization_name\": \"${ORG_NAME}\",
        \"primary_domain\": \"${DOMAIN}\",
        \"tier\": \"${TIER}\",
        \"admin_email_local_part\": \"${ADMIN_USER}\",
        \"admin_phone\": \"${ADMIN_PHONE}\",
        \"admin_initial_password\": \"umang_sso_$(openssl rand -hex 8)\"
    }")

TENANT_ID=$(echo "$RESPONSE" | jq -r '.tenant_id // empty')
if [ -z "$TENANT_ID" ]; then
    # Fallback if tenant already exists in database
    SLUG=$(echo "$DOMAIN" | tr '.-' '__')
    TENANT_ID="tnt_${SLUG}"
    echo "ℹ️  Tenant already exists or returned non-creation response; using tenant_id=${TENANT_ID}"
fi

# Provision any extra mailboxes
if [ "${#EXTRA_MAILBOXES[@]}" -gt 0 ]; then
    echo "📬 [2/5] Provisioning ${#EXTRA_MAILBOXES[@]} additional mailbox(es) for ${TENANT_ID}..."
    for entry in "${EXTRA_MAILBOXES[@]}"; do
        LOCAL_PART="${entry%%:*}"
        RAW_PHONE="${entry#*:}"
        NORM_PHONE="$(normalize_phone "$RAW_PHONE")"
        echo "   -> Creating ${LOCAL_PART}@${DOMAIN} bound to ${NORM_PHONE}..."
        curl -sS -X POST "${API_URL}/api/v1/tenants/${TENANT_ID}/mailboxes" \
            -H "Content-Type: application/json" \
            -H "X-API-Key: ${MASTER_KEY}" \
            -d "{
                \"local_part\": \"${LOCAL_PART}\",
                \"domain_name\": \"${DOMAIN}\",
                \"phone\": \"${NORM_PHONE}\",
                \"password\": \"umang_sso_$(openssl rand -hex 8)\",
                \"quota_mb\": 10240
            }" >/dev/null || true
    done
else
    echo "📬 [2/5] No additional mailboxes requested beyond primary admin (${ADMIN_USER}@${DOMAIN})."
fi

echo "🔍 [3/5] Fetching Control Plane DNS bundle & live Cloudflare DNS records for ${DOMAIN}..."
DNS_JSON=$(curl -sS "${API_URL}/api/v1/domains/${DOMAIN}/dns")
IDENTITIES_JSON=$(curl -sS -H "X-API-Key: ${MASTER_KEY}" "${API_URL}/api/v1/domains/${DOMAIN}/identities")
BIND_ZONE_TAIL=$(echo "$DNS_JSON" | jq -r '.bind_zone // .bind_zone_file // empty')

# Inspect existing live DNS records via dig so SOA, NS, and Firebase A/TXT are preserved
SOA_LINE=$(dig +short SOA "${DOMAIN}" | head -n 1 || true)
if [ -z "$SOA_LINE" ]; then
    SOA_LINE="aida.ns.cloudflare.com. dns.cloudflare.com. $(date +%Y%m%d01) 10000 2400 604800 1800"
fi
NS_LINES=$(dig +short NS "${DOMAIN}" | sort || true)
A_RECORD=$(dig +short A "${DOMAIN}" | head -n 1 || true)
HOSTING_TXT=$(dig +short TXT "${DOMAIN}" | grep "hosting-site=" | head -n 1 || true)

ZONE_FILE="$ROOT_DIR/domains/${DOMAIN}.txt"
OUT_FILE="$ROOT_DIR/domains/${DOMAIN}-DNS-SETUP.txt"

echo "📝 [4/5] Writing Cloudflare BIND Zone Export to ${ZONE_FILE}..."
{
    echo ";;"
    echo ";; Domain:     ${DOMAIN}."
    echo ";; Exported:   $(date -u '+%Y-%m-%d %H:%M:%S')"
    echo ";;"
    echo ";; This file is intended for use for informational and archival"
    echo ";; purposes ONLY and MUST be edited before use on a production"
    echo ";; DNS server.  In particular, you must:"
    echo ";;   -- update the SOA record with the correct authoritative name server"
    echo ";;   -- update the SOA record with the contact e-mail address information"
    echo ";;   -- update the NS record(s) with the authoritative name servers for this domain."
    echo ";;"
    echo ";; For further information, please consult the BIND documentation"
    echo ";; located on the following website:"
    echo ";;"
    echo ";; http://www.isc.org/"
    echo ";;"
    echo ";; And RFC 1035:"
    echo ";;"
    echo ";; http://www.ietf.org/rfc/rfc1035.txt"
    echo ";;"
    echo ";; Please note that we do NOT offer technical support for any use"
    echo ";; of this zone data, the BIND name server, or any other third-party"
    echo ";; DNS software."
    echo ";;"
    echo ";; Use at your own risk."
    echo ";; SOA Record"
    printf "%s.\t3600\tIN\tSOA\t%s\n\n" "${DOMAIN}" "${SOA_LINE}"
    echo ";; NS Records"
    if [ -n "$NS_LINES" ]; then
        while IFS= read -r ns; do
            [ -n "$ns" ] && printf "%s.\t86400\tIN\tNS\t%s\n" "${DOMAIN}" "${ns}"
        done <<< "$NS_LINES"
    else
        printf "%s.\t86400\tIN\tNS\taida.ns.cloudflare.com.\n" "${DOMAIN}"
        printf "%s.\t86400\tIN\tNS\treese.ns.cloudflare.com.\n" "${DOMAIN}"
    fi
    echo ""
    if [ -n "$A_RECORD" ]; then
        echo ";; A Records"
        printf "%s.\t1\tIN\tA\t%s ; cf_tags=cf-proxied:false\n\n" "${DOMAIN}" "${A_RECORD}"
    fi
    # Strip the generic header from BIND_ZONE_TAIL and append starting from ;; CNAME Records
    echo "$BIND_ZONE_TAIL" | sed -n '/^;; CNAME Records/,$p'
    if [ -n "$HOSTING_TXT" ]; then
        printf "%s.\t1\tIN\tTXT\t%s\n" "${DOMAIN}" "${HOSTING_TXT}"
    fi
} > "$ZONE_FILE"

cat <<EOF > "$OUT_FILE"
================================================================================
KA-POSONG PLUG-AND-PLAY DNS & UMAIL SETUP BUNDLE FOR: ${DOMAIN}
Organization: ${ORG_NAME} | Tier: ${TIER} | Tenant ID: ${TENANT_ID}
Generated At: $(date -Iseconds)
================================================================================

uMail Instant Web Client URL: https://${DOMAIN}/umail
Cloudflare BIND Zone File:    ${ZONE_FILE}

ACTIVE MAILBOX IDENTITIES:
$(echo "$IDENTITIES_JSON" | jq -r '.identities[] | "  - \(.email)  -->  UMANG Phone: \(.phone) (\(.digits // .phone_digits)) [Role: \(.role)]"')

CLOUDFLARE BIND ZONE EXPORT (${ZONE_FILE}):
--------------------------------------------------------------------------------
$(cat "$ZONE_FILE")
--------------------------------------------------------------------------------

RAW CONTROL PLANE DNS BUNDLE JSON:
${DNS_JSON}
================================================================================
EOF

if [ -n "$WEB_DIR" ] && [ -d "$WEB_DIR" ]; then
    echo "🚀 [5/5] Building custom uMail PWA for ${DOMAIN} and injecting into ${WEB_DIR}/public/umail..."
    (
        cd "$ROOT_DIR/umail-web-client"
        VITE_TENANT_DOMAIN="${DOMAIN}" VITE_TENANT_NAME="uMail — ${ORG_NAME}" npm run build
        mkdir -p "${WEB_DIR}/public/umail"
        rm -rf "${WEB_DIR}/public/umail/"*
        cp -r dist/* "${WEB_DIR}/public/umail/"
        sed -i "s#<title>.*</title>#<title>uMail — Instant Business Mail | ${ORG_NAME}</title>#g" "${WEB_DIR}/public/umail/index.html"
        # Restore default multi-tenant dist in ka-posong/umail-web-client
        npm run build >/dev/null 2>&1
    )
    cp "$ZONE_FILE" "${WEB_DIR}/${DOMAIN}-cloudflare-zone.txt"
    echo "✅ Injected custom uMail PWA into ${WEB_DIR}/public/umail and copied zone file to ${WEB_DIR}/${DOMAIN}-cloudflare-zone.txt"
else
    echo "⏭️  [5/5] No --web-dir specified; skipping website public/umail injection."
fi

echo "✅ Onboarding complete!"
echo "   -> Cloudflare BIND Zone File: $ZONE_FILE"
echo "   -> Full Setup Bundle:         $OUT_FILE"
