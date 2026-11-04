// ============================================================================
// KA-POSONG EMBEDDED HTMX + TAILWIND MANAGERIAL DASHBOARD (src/dashboard.rs)
// Served at GET /ops (Protected by DEVOPS_MASTER / Tailscale CGNAT Subnet)
// ============================================================================

use axum::{
    extract::State,
    response::{Html, IntoResponse},
};
use sqlx::Row;
use std::sync::Arc;

use crate::AppState;

pub async fn render_ops_dashboard(State(state): State<Arc<AppState>>) -> impl IntoResponse {
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
                <td class="py-3 px-4"><code class="text-xs bg-slate-100 px-2 py-1 rounded text-slate-600">{api_key}</code></td>
                <td class="py-3 px-4"><span class="px-2 py-0.5 rounded text-xs font-semibold bg-emerald-100 text-emerald-800">{status}</span></td>
            </tr>"#,
            org = org,
            tid = tid,
            tier = tier,
            tier_badge_color = tier_badge_color,
            used_dom = used_dom,
            max_dom = max_dom,
            used_mbx = used_mbx,
            max_mbx = max_mbx,
            quota_gb = quota / (1024 * 1024 * 1024),
            pct = pct,
            api_key = api_key,
            status = status
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

        domain_rows_html.push_str(&format!(
            r#"<tr class="border-b border-slate-100 hover:bg-slate-50/70">
                <td class="py-3 px-4 font-bold text-purple-900">https://{dom}{umail_path}<br><span class="text-xs font-normal text-slate-500">Tenant: {tid}</span></td>
                <td class="py-3 px-4 font-mono text-xs text-slate-600">{sel}._domainkey.{dom}</td>
                <td class="py-3 px-4"><input readonly value="{pk}" class="w-full text-xs font-mono bg-slate-100 p-1.5 rounded border border-slate-200"/></td>
                <td class="py-3 px-4">{ver_badge}</td>
            </tr>"#,
            dom = dom,
            umail_path = umail_path,
            tid = tid,
            sel = sel,
            pk = pk,
            ver_badge = ver_badge
        ));
    }

    let mut mailbox_rows_html = String::new();
    for m in &mailboxes {
        let email: String = m.get("email");
        let phone: String = m.get("phone");
        let name: String = m.get("display_name");
        let role: String = m.get("role");
        let wa: i64 = m.get("whatsapp_otp_enabled");
        let channel = if wa == 1 { "WhatsApp + SMS" } else { "SMS Only" };

        mailbox_rows_html.push_str(&format!(
            r#"<tr class="border-b border-slate-100 hover:bg-slate-50/70">
                <td class="py-2.5 px-4 font-semibold text-slate-800">{email}</td>
                <td class="py-2.5 px-4 font-mono text-sm text-purple-700 font-semibold">{phone}</td>
                <td class="py-2.5 px-4 text-sm text-slate-700">{name} <span class="text-xs uppercase px-1.5 py-0.5 bg-slate-100 rounded ml-1">{role}</span></td>
                <td class="py-2.5 px-4 text-xs text-emerald-700 font-medium">{channel}</td>
            </tr>"#,
            email = email,
            phone = phone,
            name = name,
            role = role,
            channel = channel
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

        arm_rows_html.push_str(&format!(
            r#"<tr class="border-b border-slate-100">
                <td class="py-2.5 px-4 font-semibold text-slate-800">{mname}<br><span class="text-xs font-mono text-slate-400">{mid} ({tid})</span></td>
                <td class="py-2.5 px-4 font-mono text-xs text-slate-600">{url}</td>
                <td class="py-2.5 px-4 text-xs text-slate-600">{scopes}</td>
                <td class="py-2.5 px-4">
                    <button onclick="toggleArm('{mid}')" class="px-3 py-1 rounded-full text-xs font-bold {btn_cls}">{btn_label}</button>
                </td>
            </tr>"#,
            mname = mname,
            mid = mid,
            tid = tid,
            url = url,
            scopes = scopes,
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
                <p class="text-purple-100 text-sm mt-1">Stalwart Core Engine • Tailscale Funnel Ingress ({hostname}) • UMANG Phone+OTP Identity</p>
            </div>
            <div class="flex items-center gap-3">
                <a href="/umail" class="px-4 py-2 bg-white/15 hover:bg-white/25 rounded-lg text-sm font-semibold transition">Open uMail PWA (/umail)</a>
                <button onclick="document.getElementById('onboardModal').showModal()" class="px-4 py-2 bg-amber-400 hover:bg-amber-300 text-slate-950 rounded-lg text-sm font-bold shadow transition">
                    + Onboard New Client Domain
                </button>
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
                <div class="text-xs text-slate-500 mt-1">CRM, Billing &amp; WhatsApp Hooks</div>
            </div>
        </div>

        <!-- Tenants Table -->
        <section class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div class="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                <h2 class="font-bold text-lg text-slate-800">1. Multi-Tenant Organizations &amp; Business Tier Quotas</h2>
                <span class="text-xs text-slate-400">Mirrored to Stalwart Principal &amp; Quota Records</span>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr class="bg-slate-50 text-xs uppercase text-slate-500 border-b border-slate-200">
                            <th class="py-3 px-4">Organization</th>
                            <th class="py-3 px-4">Business Tier</th>
                            <th class="py-3 px-4">Domains</th>
                            <th class="py-3 px-4">Mailbox Quota Usage</th>
                            <th class="py-3 px-4">Scoped API Key</th>
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
                        <input name="admin_phone" required placeholder="+26658000001" class="w-full px-3 py-2 border rounded-lg text-sm"/>
                    </div>
                </div>
                <div>
                    <label class="block text-xs font-bold uppercase text-slate-600 mb-1">DevOps Master API Key</label>
                    <input name="api_key" value="{master_key}" class="w-full px-3 py-2 border rounded-lg text-xs font-mono bg-slate-50"/>
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
                    <input name="tenant_id" required placeholder="tnt_liparola_org" value="tnt_liparola_org" class="w-full px-3 py-2 border rounded-lg text-sm font-mono"/>
                </div>
                <div>
                    <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Email Address</label>
                    <input name="email" type="email" required placeholder="user@liparola.org" class="w-full px-3 py-2 border rounded-lg text-sm"/>
                </div>
                <div>
                    <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Lesotho Phone (+266########)</label>
                    <input name="phone" required placeholder="+26657284264" class="w-full px-3 py-2 border rounded-lg text-sm"/>
                </div>
                <div>
                    <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Display Name</label>
                    <input name="display_name" required placeholder="Khahliso Ramotoai" class="w-full px-3 py-2 border rounded-lg text-sm"/>
                </div>
                <input type="hidden" name="api_key" value="{master_key}"/>
                <div class="flex justify-end gap-2 pt-3">
                    <button type="button" onclick="document.getElementById('mailboxModal').close()" class="px-4 py-2 border rounded-lg text-sm">Cancel</button>
                    <button type="submit" class="px-4 py-2 bg-[#6200ee] text-white rounded-lg text-sm font-bold">Create Mailbox</button>
                </div>
            </form>
        </div>
    </dialog>

    <script>
        async function submitOnboard(e) {{
            e.preventDefault();
            const f = e.target;
            const resBox = document.getElementById('onboardResult');
            resBox.classList.remove('hidden');
            resBox.textContent = 'Provisioning in Stalwart & generating DKIM records...';
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
                headers: {{ 'Content-Type': 'application/json', 'X-API-Key': f.api_key.value }},
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
            const resp = await fetch(`/api/v1/tenants/${{tid}}/mailboxes`, {{
                method: 'POST',
                headers: {{ 'Content-Type': 'application/json', 'X-API-Key': f.api_key.value }},
                body: JSON.stringify(payload)
            }});
            if (resp.ok) {{
                window.location.reload();
            }} else {{
                alert('Error: ' + (await resp.text()));
            }}
        }}

        async function toggleArm(moduleId) {{
            await fetch(`/api/v1/admin/arms/${{moduleId}}/toggle`, {{
                method: 'POST',
                headers: {{ 'X-API-Key': '{master_key}' }}
            }});
            window.location.reload();
        }}
    </script>
</body>
</html>"#,
        hostname = state.primary_mail_hostname,
        tenant_count = tenants.len(),
        domain_count = domains.len(),
        mailbox_count = mailboxes.len(),
        arm_count = arms.len(),
        tenant_rows_html = tenant_rows_html,
        domain_rows_html = domain_rows_html,
        mailbox_rows_html = mailbox_rows_html,
        arm_rows_html = arm_rows_html,
        master_key = state.master_devops_key
    );

    Html(html)
}
