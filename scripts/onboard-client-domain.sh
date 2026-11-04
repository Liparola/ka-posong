#!/usr/bin/env bash
# ============================================================================
# KA-POSONG CLIENT DOMAIN ONBOARDING CLI WRAPPER
# Usage: ./scripts/onboard-client-domain.sh "<ORG_NAME>" <DOMAIN> <TIER> <ADMIN_USER> [ADMIN_PHONE]
# Outputs: ./domains/<DOMAIN>-DNS-SETUP.txt
# ============================================================================
set -euo pipefail

if [ "$#" -lt 4 ]; then
    echo "Usage: $0 \"<ORG_NAME>\" <DOMAIN> <TIER: STARTER|GROWTH|ENTERPRISE> <ADMIN_USER> [ADMIN_PHONE]"
    exit 1
fi

ORG_NAME="$1"
DOMAIN="$2"
TIER="$(echo "$3" | tr '[:lower:]' '[:upper:]')"
ADMIN_USER="$4"
ADMIN_PHONE="${5:-+26657284264}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT_DIR/domains"

if [ -f "$ROOT_DIR/.env" ]; then
    # shellcheck disable=SC1091
    source "$ROOT_DIR/.env"
fi

API_URL="${CONTROL_PLANE_URL:-http://127.0.0.1:3000}"
MASTER_KEY="${MASTER_DEVOPS_KEY:-devops-master-key}"

echo "🌐 Provisioning tenant '${ORG_NAME}' (${DOMAIN}) on tier ${TIER}..."

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

OUT_FILE="$ROOT_DIR/domains/${DOMAIN}-DNS-SETUP.txt"

cat <<EOF > "$OUT_FILE"
================================================================================
KA-POSONG PLUG-AND-PLAY DNS & UMAIL SETUP BUNDLE FOR: ${DOMAIN}
Organization: ${ORG_NAME} | Tier: ${TIER}
Generated At: $(date -Iseconds)
================================================================================

uMail Instant Web Client URL: https://${DOMAIN}/umail
Admin Mailbox:                ${ADMIN_USER}@${DOMAIN}
Bound UMANG Phone ID:         ${ADMIN_PHONE}

RAW CONTROL PLANE JSON PROVISIONING RESPONSE:
${RESPONSE}
================================================================================
EOF

echo "✅ Domain provisioned! Plug-and-play DNS setup written to: $OUT_FILE"
cat "$OUT_FILE"
