// ============================================================================
// KA-POSONG EMBEDDED HTMX + TAILWIND MANAGERIAL DASHBOARD (src/dashboard.rs)
// Served at GET /ops (Protected by DEVOPS_MASTER Key / Signed HttpOnly Cookie)
// Zero secrets embedded in HTML or client-side JavaScript.
// ============================================================================

use axum::{
    body::Bytes,
    extract::State,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Json, Redirect, Response},
};
use serde::Deserialize;
use sqlx::Row;
use std::sync::Arc;

use crate::{
    auth::{
        constant_time_eq, create_ops_session_token, resolve_auth_context, AuthContext, Role,
        OPS_SESSION_COOKIE,
    },
    AppState,
};

#[derive(Debug, Deserialize)]
struct OpsLoginPayload {
    master_key: String,
}

fn escape_html(raw: &str) -> String {
    raw.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn mask_secret(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    if chars.len() <= 12 {
        return "••••••••".to_string();
    }
    let prefix: String = chars.iter().take(10).collect();
    let suffix: String = chars.iter().skip(chars.len() - 4).collect();
    format!("{}••••{}", prefix, suffix)
}

fn percent_decode_form(input: &str) -> String {
    let replaced = input.replace('+', " ");
    let bytes = replaced.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex_str) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex_str, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn extract_form_field(body: &[u8], field_name: &str) -> Option<String> {
    let raw = std::str::from_utf8(body).ok()?;
    for pair in raw.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if percent_decode_form(k) == field_name {
                return Some(percent_decode_form(v));
            }
        }
    }
    None
}

fn is_https_request(headers: &HeaderMap) -> bool {
    headers
        .get("X-Forwarded-Proto")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("https"))
        .unwrap_or(false)
}

fn render_ops_login_html(has_error: bool) -> Html<String> {
    let err_banner = if has_error {
        r#"<div class="mb-4 p-3 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-200 text-xs font-semibold">Invalid DevOps Master Key. Authentication denied.</div>"#
    } else {
        ""
    };

    Html(format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ka-posong Control Plane Sign In | Liparola SaaS</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-6 font-sans">
    <div class="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-8">
        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-500/20 text-purple-300 text-xs font-bold uppercase tracking-wider mb-4">
            Liparola DevOps Guard
        </div>
        <h1 class="text-2xl font-bold text-white mb-1">ka-posong Control Plane</h1>
        <p class="text-sm text-slate-400 mb-6">Operator authentication is required to access multi-tenant mail, DNS, and UMANG identity controls.</p>
        {err_banner}
        <form method="POST" action="/ops/login" class="space-y-4">
            <div>
                <label for="master_key" class="block text-xs font-bold uppercase text-slate-400 mb-1.5">DevOps Master API Key</label>
                <input id="master_key" name="master_key" type="password" required autocomplete="current-password" placeholder="Enter master key" class="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:border-purple-500" />
            </div>
            <button type="submit" class="w-full py-2.5 bg-[#6200ee] hover:bg-purple-700 text-white font-bold rounded-xl text-sm transition">
                Authenticate Ops Session
            </button>
        </form>
        <div class="mt-6 pt-4 border-t border-slate-800 flex items-center justify-between text-xs text-slate-500">
            <span>UMANG Tenant: tnt_ka_posong</span>
            <a href="/umail" class="text-purple-400 hover:underline">uMail Client &rarr;</a>
        </div>
    </div>
</body>
</html>"#,
        err_banner = err_banner
    ))
}

/// POST /ops/login
/// Validates `MASTER_DEVOPS_KEY` in constant time and issues an `HttpOnly; SameSite=Strict` session cookie.
pub async fn ops_login_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let is_json = content_type.contains("application/json");

    let submitted_key = if is_json {
        serde_json::from_slice::<OpsLoginPayload>(&body)
            .map(|p| p.master_key)
            .unwrap_or_default()
    } else {
        extract_form_field(&body, "master_key").unwrap_or_default()
    };

    if submitted_key.trim().is_empty()
        || !constant_time_eq(submitted_key.trim(), &state.master_devops_key)
    {
        if is_json {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "Invalid DevOps Master Key" })),
            )
                .into_response();
        }
        return (StatusCode::UNAUTHORIZED, render_ops_login_html(true)).into_response();
    }

    let session_token = create_ops_session_token(&state.jwt_secret);
    let secure_attr = if is_https_request(&headers) {
        "; Secure"
    } else {
        ""
    };
    let cookie_val = format!(
        "{}={}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800{}",
        OPS_SESSION_COOKIE, session_token, secure_attr
    );

    if is_json {
        let mut resp = (
            StatusCode::OK,
            Json(serde_json::json!({
                "authenticated": true,
                "role": "DEVOPS_MASTER"
            })),
        )
            .into_response();
        if let Ok(hv) = HeaderValue::from_str(&cookie_val) {
            resp.headers_mut().insert(header::SET_COOKIE, hv);
        }
        return resp;
    }

    let mut resp = Redirect::to("/ops").into_response();
    if let Ok(hv) = HeaderValue::from_str(&cookie_val) {
        resp.headers_mut().insert(header::SET_COOKIE, hv);
    }
    resp
}

/// POST /ops/logout
pub async fn ops_logout_handler(headers: HeaderMap) -> Response {
    let secure_attr = if is_https_request(&headers) {
        "; Secure"
    } else {
        ""
    };
    let clear_cookie = format!(
        "{}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{}",
        OPS_SESSION_COOKIE, secure_attr
    );
    let mut resp = Redirect::to("/ops").into_response();
    if let Ok(hv) = HeaderValue::from_str(&clear_cookie) {
        resp.headers_mut().insert(header::SET_COOKIE, hv);
    }
    resp
}

/// GET /ops & GET /ops-dashboard
pub async fn render_ops_dashboard(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let is_master = matches!(
        resolve_auth_context(&state, &headers).await,
        Ok(AuthContext {
            role: Role::DevOpsMaster
        })
    );

    if !is_master {
        return (StatusCode::UNAUTHORIZED, render_ops_login_html(false)).into_response();
    }

    let tenants = sqlx::query(
        "SELECT id, org_name, tier, raw_api_key, max_domains, max_mailboxes, storage_quota_bytes, status, created_at FROM tenants ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let domains = sqlx::query(
        "SELECT domain_name, tenant_id, dkim_selector, dkim_public_key, umail_path, verified_at FROM domains ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let mailboxes = sqlx::query(
        "SELECT email, tenant_id, phone, display_name, role, whatsapp_otp_enabled, status FROM mailboxes ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let arms = sqlx::query(
        "SELECT module_id, tenant_id, module_name, webhook_url, scopes, enabled FROM extending_arms ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let mut tenant_rows_html = String::new();
    for t in &tenants {
        let tid: String = t.get("id");
        let org: String = t.get("org_name");
        let tier: String = t.get("tier");
        let api_key: String = t.get("raw_api_key");
        let max_dom: i64 = t.get("max_domains");
        let max_mbx: i64 = t.get("max_mailboxes");
        let quota: i64 = t.get("storage_quota_bytes");
        let status: String = t.get("status");

        let used_mbx = mailboxes
            .iter()
            .filter(|m| m.get::<String, _>("tenant_id") == tid)
            .count() as i64;
        let used_dom = domains
            .iter()
            .filter(|d| d.get::<String, _>("tenant_id") == tid)
            .count() as i64;

        let pct = if max_mbx > 0 {
            ((used_mbx as f64 / max_mbx as f64) * 100.0).min(100.0) as u32
        } else {
            0
        };

        let tier_badge_color = match tier.as_str() {
            "ENTERPRISE" => "bg-purple-100 text-purple-800 border-purple-300",
            "GROWTH" => "bg-indigo-100 text-indigo-800 border-indigo-300",
            _ => "bg-slate-100 text-slate-800 border-slate-300",
        };

        tenant_rows_html.push_str(&format!(
            r#"<tr class="border-b border-slate-100 hover:bg-slate-50/70">
                <td class="py-3 px-4 font-semibold text-slate-900">{org}<br><span class="text-xs font-mono text-slate-400">{tid}</span></td>
                <td class="py-3 px-4"><span class="px-2.5 py-1 rounded-full text-xs font-bold border {tier_badge_color}">{tier}</span></td>
                <td class="py-3 px-4 text-sm text-slate-700">{used_dom} / {max_dom}</td>
                <td class="py-3 px-4">
                    <div class="flex items-center justify-between text-xs mb-1">
                        <span class="font-medium text-slate-700">{used_mbx} / {max_mbx} Mailboxes</span>
                        <span class="text-slate-400">{quota_gb} GB</span>
                    </div>
                    <div class="w-full bg-slate-200 h-2 rounded-full overflow-hidden">
                        <div class="bg-purple-700 h-2 rounded-full" style="width: {pct}%"></div>
                    </div>
                </td>
                <td class="py-3 px-4"><code class="text-xs bg-slate-100 px-2 py-1 rounded text-slate-600">{masked_key}</code></td>
                <td class="py-3 px-4"><span class="px-2 py-0.5 rounded text-xs font-semibold bg-emerald-100 text-emerald-800">{status}</span></td>
            </tr>"#,
            org = escape_html(&org),
            tid = escape_html(&tid),
            tier = escape_html(&tier),
            tier_badge_color = tier_badge_color,
            used_dom = used_dom,
            max_dom = max_dom,
            used_mbx = used_mbx,
            max_mbx = max_mbx,
            quota_gb = quota / (1024 * 1024 * 1024),
            pct = pct,
            masked_key = escape_html(&mask_secret(&api_key)),
            status = escape_html(&status)
        ));
    }

    let mut domain_rows_html = String::new();
    for d in &domains {
        let dom: String = d.get("domain_name");
        let tid: String = d.get("tenant_id");
        let sel: String = d.get("dkim_selector");
        let pk: String = d.get("dkim_public_key");
        let umail_path: String = d.get("umail_path");
        let verified: Option<String> = d.get("verified_at");
        let ver_badge = if verified.is_some() {
            r#"<span class="px-2 py-0.5 rounded text-xs font-semibold bg-emerald-100 text-emerald-800">VERIFIED</span>"#
        } else {
            r#"<span class="px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-800">PENDING DNS</span>"#
        };

        let esc_dom = escape_html(&dom);
        domain_rows_html.push_str(&format!(
            r#"<tr class="border-b border-slate-100 hover:bg-slate-50/70">
                <td class="py-3 px-4 font-bold text-purple-900">https://{dom}{umail_path}<br><span class="text-xs font-normal text-slate-500">Tenant: {tid}</span></td>
                <td class="py-3 px-4 font-mono text-xs text-slate-600">{sel}._domainkey.{dom}</td>
                <td class="py-3 px-4"><input readonly value="{pk}" class="w-full text-xs font-mono bg-slate-100 p-1.5 rounded border border-slate-200"/></td>
                <td class="py-3 px-4">{ver_badge}</td>
                <td class="py-3 px-4">
                    <button onclick="openDnsModal('{dom}')" class="px-2.5 py-1 bg-purple-50 hover:bg-purple-100 text-[#6200ee] border border-purple-200 rounded text-xs font-bold transition">
                        📋 View / Export DNS
                    </button>
                </td>
            </tr>"#,
            dom = esc_dom,
            umail_path = escape_html(&umail_path),
            tid = escape_html(&tid),
            sel = escape_html(&sel),
            pk = escape_html(&pk),
            ver_badge = ver_badge
        ));
    }

    let mut mailbox_rows_html = String::new();
    for m in &mailboxes {
        let email: String = m.get("email");
        let tid: String = m.get("tenant_id");
        let phone: String = m.get("phone");
        let name: String = m.get("display_name");
        let role: String = m.get("role");
        let wa: i64 = m.get("whatsapp_otp_enabled");
        let channel = if wa == 1 { "WhatsApp + SMS" } else { "SMS Only" };

        let esc_email = escape_html(&email);
        mailbox_rows_html.push_str(&format!(
            r#"<tr class="border-b border-slate-100 hover:bg-slate-50/70">
                <td class="py-2.5 px-4 font-semibold text-slate-800">{email}</td>
                <td class="py-2.5 px-4 font-mono text-sm text-purple-700 font-semibold">{phone}</td>
                <td class="py-2.5 px-4 text-sm text-slate-700">{name} <span class="text-xs uppercase px-1.5 py-0.5 bg-slate-100 rounded ml-1">{role}</span></td>
                <td class="py-2.5 px-4 text-xs text-emerald-700 font-medium">{channel}</td>
                <td class="py-2.5 px-4">
                    <button onclick="deleteMailbox('{email}', '{tid}')" class="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded text-xs font-bold transition inline-flex items-center gap-1">
                        🗑️ Delete
                    </button>
                </td>
            </tr>"#,
            email = esc_email,
            phone = escape_html(&phone),
            name = escape_html(&name),
            role = escape_html(&role),
            channel = channel,
            tid = escape_html(&tid)
        ));
    }

    let mut arm_rows_html = String::new();
    for a in &arms {
        let mid: String = a.get("module_id");
        let tid: String = a.get("tenant_id");
        let mname: String = a.get("module_name");
        let url: String = a.get("webhook_url");
        let scopes: String = a.get("scopes");
        let enabled: i64 = a.get("enabled");
        let btn_label = if enabled == 1 { "Enabled (ON)" } else { "Disabled (OFF)" };
        let btn_cls = if enabled == 1 {
            "bg-emerald-600 text-white"
        } else {
            "bg-slate-300 text-slate-700"
        };

        let esc_mid = escape_html(&mid);
        arm_rows_html.push_str(&format!(
            r#"<tr class="border-b border-slate-100">
                <td class="py-2.5 px-4 font-semibold text-slate-800">{mname}<br><span class="text-xs font-mono text-slate-400">{mid} ({tid})</span></td>
                <td class="py-2.5 px-4 font-mono text-xs text-slate-600">{url}</td>
                <td class="py-2.5 px-4 text-xs text-slate-600">{scopes}</td>
                <td class="py-2.5 px-4">
                    <button onclick="toggleArm('{mid}')" class="px-3 py-1 rounded-full text-xs font-bold {btn_cls}">{btn_label}</button>
                </td>
            </tr>"#,
            mname = escape_html(&mname),
            mid = esc_mid,
            tid = escape_html(&tid),
            url = escape_html(&url),
            scopes = escape_html(&scopes),
            btn_cls = btn_cls,
            btn_label = btn_label
        ));
    }

    let html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ka-posong Control Plane &amp; UMANG Ops Dashboard | Liparola</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/htmx.org@1.9.12"></script>
</head>
<body class="bg-slate-50 text-slate-900 min-h-screen font-sans">
    <header class="bg-gradient-to-r from-[#6200ee] to-purple-800 text-white shadow-lg">
        <div class="max-w-7xl mx-auto px-6 py-5 flex flex-wrap items-center justify-between gap-4">
            <div>
                <div class="flex items-center gap-3">
                    <span class="px-2.5 py-1 bg-white/20 rounded-md text-xs font-bold tracking-wider uppercase">Liparola SaaS</span>
                    <h1 class="text-2xl font-bold tracking-tight">ka-posong Multi-Tenant Mail &amp; UMANG Control Plane</h1>
                </div>
                <p class="text-purple-100 text-sm mt-1">Stalwart Core Engine • Tailscale Funnel Ingress ({hostname}) • UMANG Core Tenant ({umang_tid})</p>
            </div>
            <div class="flex flex-wrap items-center gap-3">
                <a href="/umail" class="px-4 py-2 bg-white/15 hover:bg-white/25 rounded-lg text-sm font-semibold transition">Open uMail PWA (/umail)</a>
                <button onclick="exportAllDns()" class="px-4 py-2 bg-white/15 hover:bg-white/25 rounded-lg text-sm font-semibold transition">
                    📤 Export All DNS
                </button>
                <button onclick="document.getElementById('onboardModal').showModal()" class="px-4 py-2 bg-amber-400 hover:bg-amber-300 text-slate-950 rounded-lg text-sm font-bold shadow transition">
                    + Onboard New Client Domain
                </button>
                <form method="POST" action="/ops/logout" class="inline">
                    <button type="submit" class="px-3.5 py-2 bg-slate-950/40 hover:bg-slate-950/60 rounded-lg text-xs font-bold transition">Sign Out</button>
                </form>
            </div>
        </div>
    </header>

    <main class="max-w-7xl mx-auto px-6 py-8 space-y-8">
        <!-- Summary Metrics -->
        <div class="grid grid-cols-1 md:grid-cols-4 gap-5">
            <div class="bg-white p-5 rounded-xl shadow-sm border border-slate-200/80 border-l-4 border-l-[#6200ee]">
                <div class="text-xs font-bold uppercase text-slate-400">Active Tenants</div>
                <div class="text-3xl font-extrabold text-slate-900 mt-1">{tenant_count}</div>
                <div class="text-xs text-slate-500 mt-1">Starter / Growth / Enterprise</div>
            </div>
            <div class="bg-white p-5 rounded-xl shadow-sm border border-slate-200/80 border-l-4 border-l-emerald-600">
                <div class="text-xs font-bold uppercase text-slate-400">Provisioned Domains</div>
                <div class="text-3xl font-extrabold text-slate-900 mt-1">{domain_count}</div>
                <div class="text-xs text-slate-500 mt-1">Auto-DKIM &amp; /umail Configured</div>
            </div>
            <div class="bg-white p-5 rounded-xl shadow-sm border border-slate-200/80 border-l-4 border-l-purple-600">
                <div class="text-xs font-bold uppercase text-slate-400">UMANG Phone Mailboxes</div>
                <div class="text-3xl font-extrabold text-slate-900 mt-1">{mailbox_count}</div>
                <div class="text-xs text-slate-500 mt-1">+266 Phone -&gt; Inbox Bound</div>
            </div>
            <div class="bg-white p-5 rounded-xl shadow-sm border border-slate-200/80 border-l-4 border-l-amber-500">
                <div class="text-xs font-bold uppercase text-slate-400">Extending Arm Modules</div>
                <div class="text-3xl font-extrabold text-slate-900 mt-1">{arm_count}</div>
                <div class="text-xs text-slate-500 mt-1">UMANG Core &amp; WhatsApp Hooks</div>
            </div>
        </div>

        <!-- Tenants Table -->
        <section class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div class="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                <h2 class="font-bold text-lg text-slate-800">1. Multi-Tenant Organizations &amp; Business Tier Quotas</h2>
                <span class="text-xs text-slate-400">Mirrored to Stalwart Principal &amp; UMANG Core</span>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr class="bg-slate-50 text-xs uppercase text-slate-500 border-b border-slate-200">
                            <th class="py-3 px-4">Organization</th>
                            <th class="py-3 px-4">Business Tier</th>
                            <th class="py-3 px-4">Domains</th>
                            <th class="py-3 px-4">Mailbox Quota Usage</th>
                            <th class="py-3 px-4">Scoped API Key (Masked)</th>
                            <th class="py-3 px-4">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {tenant_rows_html}
                    </tbody>
                </table>
            </div>
        </section>

        <!-- Domains & Auto-DKIM Table -->
        <section class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div class="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                <h2 class="font-bold text-lg text-slate-800">2. Registered Tenant Domains &amp; Auto-DKIM Keys</h2>
                <span class="text-xs text-slate-400">Every domain links `/umail` to the Lit+TS PWA Client</span>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr class="bg-slate-50 text-xs uppercase text-slate-500 border-b border-slate-200">
                            <th class="py-3 px-4">Tenant uMail Endpoint</th>
                            <th class="py-3 px-4">DKIM DNS Host</th>
                            <th class="py-3 px-4">DKIM Public TXT Value</th>
                            <th class="py-3 px-4">DNS Status</th>
                            <th class="py-3 px-4">DNS Provisioning</th>
                        </tr>
                    </thead>
                    <tbody>
                        {domain_rows_html}
                    </tbody>
                </table>
            </div>
        </section>

        <!-- UMANG Bound Mailboxes -->
        <section class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div class="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                <h2 class="font-bold text-lg text-slate-800">3. UMANG Phone-to-Mailbox Identity Directory</h2>
                <button onclick="document.getElementById('mailboxModal').showModal()" class="px-3 py-1.5 bg-[#6200ee] text-white rounded-lg text-xs font-bold">+ Provision Mailbox</button>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr class="bg-slate-50 text-xs uppercase text-slate-500 border-b border-slate-200">
                            <th class="py-3 px-4">Email Address</th>
                            <th class="py-3 px-4">Bound Lesotho Phone (UMANG ID)</th>
                            <th class="py-3 px-4">Display Name &amp; Role</th>
                            <th class="py-3 px-4">OTP Delivery Channel</th>
                            <th class="py-3 px-4">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {mailbox_rows_html}
                    </tbody>
                </table>
            </div>
        </section>

        <!-- Extending Arm Modules -->
        <section class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div class="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                <h2 class="font-bold text-lg text-slate-800">4. Extending Arm Microservice Webhooks</h2>
                <span class="text-xs text-slate-400">HMAC-SHA256 Signed Event Bus</span>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr class="bg-slate-50 text-xs uppercase text-slate-500 border-b border-slate-200">
                            <th class="py-3 px-4">Module</th>
                            <th class="py-3 px-4">Webhook Target URL</th>
                            <th class="py-3 px-4">Granted Scopes</th>
                            <th class="py-3 px-4">Toggle</th>
                        </tr>
                    </thead>
                    <tbody>
                        {arm_rows_html}
                    </tbody>
                </table>
            </div>
        </section>
    </main>

    <!-- 1-Click Onboard New Client Domain Modal -->
    <dialog id="onboardModal" aria-labelledby="onboardTitle" class="rounded-2xl shadow-2xl p-0 w-full max-w-xl backdrop:bg-slate-900/60">
        <div class="p-6">
            <div class="flex items-center justify-between border-b border-slate-100 pb-3 mb-4">
                <h2 id="onboardTitle" class="text-lg font-bold text-slate-900">Onboard New Client Domain &amp; Tenant</h2>
                <button onclick="document.getElementById('onboardModal').close()" class="text-slate-400 hover:text-slate-700 text-xl">&times;</button>
            </div>
            <form id="onboardForm" onsubmit="submitOnboard(event)" class="space-y-4">
                <div>
                    <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Organization Name</label>
                    <input name="organization_name" required placeholder="e.g. Liparola Technologies" class="w-full px-3 py-2 border rounded-lg text-sm"/>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Primary Domain</label>
                        <input name="primary_domain" required placeholder="e.g. client.co.ls" class="w-full px-3 py-2 border rounded-lg text-sm"/>
                    </div>
                    <div>
                        <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Business Tier</label>
                        <select name="tier" class="w-full px-3 py-2 border rounded-lg text-sm bg-white">
                            <option value="STARTER">STARTER (1 Domain, 5 Mailboxes)</option>
                            <option value="GROWTH" selected>GROWTH (3 Domains, 25 Mailboxes)</option>
                            <option value="ENTERPRISE">ENTERPRISE (Unlimited)</option>
                        </select>
                    </div>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Admin Email Local Part</label>
                        <input name="admin_email_local_part" required value="admin" class="w-full px-3 py-2 border rounded-lg text-sm"/>
                    </div>
                    <div>
                        <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Admin Phone (UMANG +266)</label>
                        <input name="admin_phone" required placeholder="+2665xxxxxxx" class="w-full px-3 py-2 border rounded-lg text-sm"/>
                    </div>
                </div>
                <pre id="onboardResult" class="hidden bg-slate-900 text-emerald-400 p-3 rounded-lg text-xs font-mono overflow-x-auto max-h-60"></pre>
                <div class="flex justify-end gap-2 pt-2">
                    <button type="button" onclick="document.getElementById('onboardModal').close()" class="px-4 py-2 border rounded-lg text-sm">Close</button>
                    <button type="submit" class="px-4 py-2 bg-[#6200ee] text-white rounded-lg text-sm font-bold">Provision &amp; Generate DNS Bundle</button>
                </div>
            </form>
        </div>
    </dialog>

    <!-- Provision Mailbox Modal -->
    <dialog id="mailboxModal" aria-labelledby="mbxTitle" class="rounded-2xl shadow-2xl p-0 w-full max-w-md backdrop:bg-slate-900/60">
        <div class="p-6">
            <h2 id="mbxTitle" class="text-lg font-bold text-slate-900 mb-4">Bind Phone &amp; Provision Tenant Mailbox</h2>
            <form onsubmit="submitMailbox(event)" class="space-y-3">
                <div>
                    <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Tenant ID</label>
                    <input name="tenant_id" required placeholder="tnt_liparola_org" class="w-full px-3 py-2 border rounded-lg text-sm font-mono"/>
                </div>
                <div>
                    <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Email Address</label>
                    <input name="email" type="email" required placeholder="user@domain.co.ls" class="w-full px-3 py-2 border rounded-lg text-sm"/>
                </div>
                <div>
                    <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Lesotho Phone (+266########)</label>
                    <input name="phone" required placeholder="+2665xxxxxxx" class="w-full px-3 py-2 border rounded-lg text-sm"/>
                </div>
                <div>
                    <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Display Name</label>
                    <input name="display_name" required placeholder="Full Name" class="w-full px-3 py-2 border rounded-lg text-sm"/>
                </div>
                <div class="flex justify-end gap-2 pt-3">
                    <button type="button" onclick="document.getElementById('mailboxModal').close()" class="px-4 py-2 border rounded-lg text-sm">Cancel</button>
                    <button type="submit" class="px-4 py-2 bg-[#6200ee] text-white rounded-lg text-sm font-bold">Create Mailbox</button>
                </div>
            </form>
        </div>
    </dialog>

    <!-- DNS Provisioning Modal -->
    <dialog id="dnsModal" aria-labelledby="dnsTitle" class="rounded-2xl shadow-2xl p-0 w-full max-w-4xl backdrop:bg-slate-900/60">
        <div class="p-6">
            <div class="flex items-center justify-between border-b border-slate-100 pb-3 mb-4">
                <div>
                    <h2 id="dnsTitle" class="text-lg font-bold text-slate-900">DNS Provisioning Matrix &amp; Export</h2>
                    <p id="dnsSubtitle" class="text-xs text-slate-500 font-mono">Loading records...</p>
                </div>
                <button onclick="document.getElementById('dnsModal').close()" class="text-slate-400 hover:text-slate-700 text-2xl">&times;</button>
            </div>

            <!-- Tab bar -->
            <div class="flex gap-2 border-b border-slate-200 mb-4">
                <button id="tabBtnTable" onclick="showDnsTab('table')" class="px-4 py-2 text-sm font-bold border-b-2 border-[#6200ee] text-[#6200ee]">📊 DNS Matrix Table</button>
                <button id="tabBtnZone" onclick="showDnsTab('zone')" class="px-4 py-2 text-sm font-semibold text-slate-500 hover:text-slate-800">📄 BIND Zone File</button>
                <button id="tabBtnCsv" onclick="showDnsTab('csv')" class="px-4 py-2 text-sm font-semibold text-slate-500 hover:text-slate-800">📋 Cloudflare CSV</button>
            </div>

            <div id="dnsTabTable" class="space-y-4">
                <div class="overflow-x-auto border border-slate-200 rounded-xl">
                    <table class="w-full text-left border-collapse text-xs">
                        <thead class="bg-slate-50 text-slate-600 font-bold uppercase border-b border-slate-200">
                            <tr>
                                <th class="p-2.5">Type</th>
                                <th class="p-2.5">Host / Name</th>
                                <th class="p-2.5">Priority</th>
                                <th class="p-2.5">Value / Content</th>
                                <th class="p-2.5">Purpose</th>
                                <th class="p-2.5">Action</th>
                            </tr>
                        </thead>
                        <tbody id="dnsTableBody" class="divide-y divide-slate-100 font-mono">
                            <!-- Injected dynamically -->
                        </tbody>
                    </table>
                </div>
            </div>

            <div id="dnsTabZone" class="hidden space-y-3">
                <div class="flex justify-between items-center">
                    <span class="text-xs text-slate-500">Standard RFC 1035 BIND Zone Format (Compatible with BIND, Route53, Namecheap, cPanel)</span>
                    <div class="flex gap-2">
                        <button onclick="copyDnsContent('dnsZoneContent')" class="px-3 py-1 bg-slate-100 hover:bg-slate-200 rounded text-xs font-bold text-slate-700">📋 Copy Zone</button>
                        <button onclick="downloadDnsFile('zone')" class="px-3 py-1 bg-[#6200ee] hover:bg-purple-800 rounded text-xs font-bold text-white">💾 Download .zone</button>
                    </div>
                </div>
                <textarea id="dnsZoneContent" readonly class="w-full h-72 font-mono text-xs p-3 bg-slate-900 text-emerald-400 rounded-xl resize-none"></textarea>
            </div>

            <div id="dnsTabCsv" class="hidden space-y-3">
                <div class="flex justify-between items-center">
                    <span class="text-xs text-slate-500">Cloudflare Dashboard DNS CSV Import (Cloudflare Dashboard -&gt; DNS -&gt; Records -&gt; Import)</span>
                    <div class="flex gap-2">
                        <button onclick="copyDnsContent('dnsCsvContent')" class="px-3 py-1 bg-slate-100 hover:bg-slate-200 rounded text-xs font-bold text-slate-700">📋 Copy CSV</button>
                        <button onclick="downloadDnsFile('csv')" class="px-3 py-1 bg-[#6200ee] hover:bg-purple-800 rounded text-xs font-bold text-white">💾 Download .csv</button>
                    </div>
                </div>
                <textarea id="dnsCsvContent" readonly class="w-full h-72 font-mono text-xs p-3 bg-slate-900 text-emerald-400 rounded-xl resize-none"></textarea>
            </div>

            <div class="flex justify-end gap-2 pt-4 border-t border-slate-100 mt-4">
                <button type="button" onclick="document.getElementById('dnsModal').close()" class="px-4 py-2 border rounded-lg text-sm font-semibold">Close</button>
            </div>
        </div>
    </dialog>

    <script>
        let currentDomainDns = null;

        async function openDnsModal(dom) {{
            const modal = document.getElementById('dnsModal');
            document.getElementById('dnsSubtitle').textContent = 'Fetching DNS bundle for ' + dom + '...';
            modal.showModal();
            showDnsTab('table');

            try {{
                const resp = await fetch('/api/v1/domains/' + encodeURIComponent(dom) + '/dns', {{
                    credentials: 'same-origin'
                }});
                if (!resp.ok) throw new Error(await resp.text());
                const data = await resp.json();
                currentDomainDns = data;
                document.getElementById('dnsSubtitle').textContent = 'Domain: ' + dom + ' • Tenant: ' + data.tenant_id;

                const tbody = document.getElementById('dnsTableBody');
                tbody.innerHTML = '';
                for (const rec of data.bundle.records) {{
                    const tr = document.createElement('tr');
                    tr.className = 'hover:bg-slate-50/70';

                    const tdType = document.createElement('td');
                    tdType.className = 'p-2.5';
                    const badge = document.createElement('span');
                    badge.className = 'px-1.5 py-0.5 rounded font-bold bg-slate-100 text-slate-800';
                    badge.textContent = rec.record_type;
                    tdType.appendChild(badge);

                    const tdHost = document.createElement('td');
                    tdHost.className = 'p-2.5 font-bold text-purple-900';
                    tdHost.textContent = rec.host;

                    const tdPrio = document.createElement('td');
                    tdPrio.className = 'p-2.5 text-slate-600';
                    tdPrio.textContent = (rec.priority !== null && rec.priority !== undefined) ? String(rec.priority) : '-';

                    const tdVal = document.createElement('td');
                    tdVal.className = 'p-2.5 max-w-xs truncate text-slate-700';
                    tdVal.title = rec.value || '';
                    tdVal.textContent = rec.value || '';

                    const tdPurpose = document.createElement('td');
                    tdPurpose.className = 'p-2.5 text-slate-500 font-sans text-xs';
                    tdPurpose.textContent = rec.purpose || '';

                    const tdAction = document.createElement('td');
                    tdAction.className = 'p-2.5';
                    const copyBtn = document.createElement('button');
                    copyBtn.className = 'px-2 py-0.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-xs font-semibold';
                    copyBtn.textContent = 'Copy';
                    copyBtn.onclick = () => {{
                        navigator.clipboard.writeText(rec.value || '');
                        alert('Copied value to clipboard!');
                    }};
                    tdAction.appendChild(copyBtn);

                    tr.append(tdType, tdHost, tdPrio, tdVal, tdPurpose, tdAction);
                    tbody.appendChild(tr);
                }}

                document.getElementById('dnsZoneContent').value = data.bind_zone;
                document.getElementById('dnsCsvContent').value = data.cloudflare_csv;
            }} catch (err) {{
                document.getElementById('dnsSubtitle').textContent = 'Error loading DNS: ' + err.message;
            }}
        }}

        function showDnsTab(tab) {{
            const tabs = ['table', 'zone', 'csv'];
            for (const t of tabs) {{
                const cap = t.charAt(0).toUpperCase() + t.slice(1);
                const el = document.getElementById('dnsTab' + cap);
                const btn = document.getElementById('tabBtn' + cap);
                if (t === tab) {{
                    el.classList.remove('hidden');
                    btn.className = 'px-4 py-2 text-sm font-bold border-b-2 border-[#6200ee] text-[#6200ee]';
                }} else {{
                    el.classList.add('hidden');
                    btn.className = 'px-4 py-2 text-sm font-semibold text-slate-500 hover:text-slate-800';
                }}
            }}
        }}

        function copyDnsContent(elementId) {{
            const val = document.getElementById(elementId).value;
            navigator.clipboard.writeText(val);
            alert('Copied to clipboard!');
        }}

        function downloadDnsFile(format) {{
            if (!currentDomainDns) return;
            const dom = currentDomainDns.domain;
            const content = format === 'zone' ? currentDomainDns.bind_zone : currentDomainDns.cloudflare_csv;
            const filename = format === 'zone' ? dom + '.zone' : dom + '-cloudflare-dns.csv';
            const mime = format === 'zone' ? 'text/plain' : 'text/csv';

            const blob = new Blob([content], {{ type: mime }});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }}

        async function exportAllDns() {{
            try {{
                const resp = await fetch('/api/v1/admin/dns/export-all', {{
                    credentials: 'same-origin'
                }});
                if (!resp.ok) throw new Error(await resp.text());
                const data = await resp.json();

                const blob = new Blob([data.combined_bind_zone], {{ type: 'text/plain' }});
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'kaposong-all-domains-' + new Date().toISOString().slice(0, 10) + '.zone';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                alert('Exported DNS bundles for ' + data.count + ' domain(s)!');
            }} catch (err) {{
                alert('Export error: ' + err.message);
            }}
        }}

        async function submitOnboard(e) {{
            e.preventDefault();
            const f = e.target;
            const resBox = document.getElementById('onboardResult');
            resBox.classList.remove('hidden');
            resBox.textContent = 'Provisioning in Stalwart & syncing with UMANG Core...';
            const payload = {{
                organization_name: f.organization_name.value,
                primary_domain: f.primary_domain.value,
                tier: f.tier.value,
                admin_email_local_part: f.admin_email_local_part.value,
                admin_phone: f.admin_phone.value,
                admin_initial_password: 'umang_sso_managed_password'
            }};
            const resp = await fetch('/api/v1/admin/tenants', {{
                method: 'POST',
                credentials: 'same-origin',
                headers: {{ 'Content-Type': 'application/json' }},
                body: JSON.stringify(payload)
            }});
            const data = await resp.json();
            resBox.textContent = JSON.stringify(data, null, 2);
            setTimeout(() => window.location.reload(), 2500);
        }}

        async function submitMailbox(e) {{
            e.preventDefault();
            const f = e.target;
            const tid = f.tenant_id.value;
            const payload = {{
                tenant_id: tid,
                email: f.email.value,
                phone: f.phone.value,
                display_name: f.display_name.value,
                password_hash_or_plain: 'umang_sso_secret'
            }};
            const resp = await fetch(`/api/v1/tenants/${{encodeURIComponent(tid)}}/mailboxes`, {{
                method: 'POST',
                credentials: 'same-origin',
                headers: {{ 'Content-Type': 'application/json' }},
                body: JSON.stringify(payload)
            }});
            if (resp.ok) {{
                window.location.reload();
            }} else {{
                alert('Error: ' + (await resp.text()));
            }}
        }}

        async function deleteMailbox(email, tid) {{
            if (!confirm(`Are you sure you want to permanently delete mailbox "${{email}}"?\n\nThis will remove the mailbox, unbind the phone from UMANG, and purge all its messages.`)) {{
                return;
            }}
            try {{
                const resp = await fetch(`/api/v1/mailboxes/${{encodeURIComponent(email)}}`, {{
                    method: 'DELETE',
                    credentials: 'same-origin'
                }});
                if (resp.ok) {{
                    alert(`Mailbox "${{email}}" has been permanently deleted.`);
                    window.location.reload();
                }} else {{
                    alert('Error deleting mailbox: ' + (await resp.text()));
                }}
            }} catch (err) {{
                alert('Request failed: ' + err.message);
            }}
        }}

        async function toggleArm(moduleId) {{
            await fetch(`/api/v1/admin/arms/${{encodeURIComponent(moduleId)}}/toggle`, {{
                method: 'POST',
                credentials: 'same-origin'
            }});
            window.location.reload();
        }}
    </script>
</body>
</html>"#,
        hostname = escape_html(&state.primary_mail_hostname),
        umang_tid = escape_html(&state.umang_tenant_id),
        tenant_count = tenants.len(),
        domain_count = domains.len(),
        mailbox_count = mailboxes.len(),
        arm_count = arms.len(),
        tenant_rows_html = tenant_rows_html,
        domain_rows_html = domain_rows_html,
        mailbox_rows_html = mailbox_rows_html,
        arm_rows_html = arm_rows_html
    );

    Html(html).into_response()
}
