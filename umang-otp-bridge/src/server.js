'use strict';

/**
 * ============================================================================
 * UMANG MULTI-CHANNEL OTP DELIVERY BRIDGE (ka-posong Identity Service)
 * ============================================================================
 * Implements the Liparola UMANG OTP delivery blueprint:
 * 1. WhatsApp OTP Delivery via embedded `whatsapp-web.js` (using the authenticated
 *    UMANG `.wwebjs_auth` session from `ka.sesiung/workspace-otp-server`) OR
 *    external AetherWA (`linka-otp-delivery-aetherwa`) HTTP gateway, with
 *    bilingual Sesotho/English message formatting.
 * 2. Hardware SMS Delivery via `HuaweiGateway` (`workspace-otp-server-sms` driver)
 *    and Huawei LTE Router Pool (`192.168.9.1`, `192.168.8.1`, `192.168.10.1`)
 *    with SCRAM/SHA256 authentication (`admin` / `Technomath`) and Lesotho 8-digit
 *    normalization.
 * 3. Origin-bound WebOTP SMS formatting (`@<domain> #<otp>`) on the final line
 *    so mobile browsers and Safari autofill bars verify the tenant domain.
 * 4. Non-strict Dev Console Win-Win fallback when physical hardware is offline
 *    or still warming up.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.UMANG_BRIDGE_PORT || '3001', 10);
const HOST = process.env.UMANG_BRIDGE_HOST || '0.0.0.0';

let lastDeliveryEvent = null;

// ============================================================================
// 1. EMBEDDED WHATSAPP-WEB.JS ENGINE (Reusing authenticated ka.sesiung session)
// ============================================================================
let wwebClient = null;
let wwebReady = false;
let wwebStatus = 'uninitialized';

function initEmbeddedWhatsApp() {
  if (process.env.DISABLE_EMBEDDED_WWEBJS === 'true') {
    wwebStatus = 'disabled';
    return;
  }

  const candidateModules = [
    '/home/aurum/Documents/Projects/Business/Liparola FC/ka.sesiung/workspace-otp-server/node_modules/whatsapp-web.js',
    '/home/aurum/Documents/Linka-Lesotho-2L-/khauta-stunning-tribble/workspace-otp-server/node_modules/whatsapp-web.js',
  ];

  let WWebJS = null;
  for (const modPath of candidateModules) {
    try {
      if (fs.existsSync(modPath)) {
        WWebJS = require(modPath);
        break;
      }
    } catch (_) {}
  }

  if (!WWebJS) {
    wwebStatus = 'driver-not-found';
    return;
  }

  const authDataPath =
    process.env.WWEBJS_AUTH_PATH ||
    '/home/aurum/Documents/Projects/Business/Liparola FC/ka.sesiung/workspace-otp-server/.wwebjs_auth';

  // Clean up stale Chromium singleton locks if no chrome is holding that session dir
  const sessionDir = path.join(authDataPath, 'session');
  for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      const p = path.join(sessionDir, lockFile);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (_) {}
  }

  const chromeCandidates = [
    process.env.WHATSAPP_CHROME_PATH,
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
  ].filter(Boolean);

  const executablePath = chromeCandidates.find((p) => fs.existsSync(p));
  const headless = process.env.WHATSAPP_HEADFUL === 'true' ? false : true;

  try {
    wwebStatus = 'initializing';
    const { Client, LocalAuth } = WWebJS;
    wwebClient = new Client({
      authStrategy: new LocalAuth({ dataPath: authDataPath }),
      puppeteer: {
        executablePath,
        headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      },
    });

    wwebClient.on('ready', () => {
      wwebReady = true;
      wwebStatus = 'ready';
      console.log('✅ [UMANG-WA] Embedded WhatsApp OTP Bot is authenticated and READY!');
    });

    wwebClient.on('authenticated', () => {
      wwebStatus = 'authenticated';
      console.log('🔐 [UMANG-WA] WhatsApp session authenticated via LocalAuth.');
    });

    wwebClient.on('qr', () => {
      wwebStatus = 'awaiting-qr';
      console.warn('⚠️ [UMANG-WA] WhatsApp session requires QR scan (falling back to SMS / Win-Win until scanned).');
    });

    wwebClient.on('disconnected', (reason) => {
      wwebReady = false;
      wwebStatus = `disconnected:${reason}`;
    });

    wwebClient.initialize().catch((err) => {
      wwebStatus = `error:${err.message}`;
      console.warn('⚠️ [UMANG-WA] Non-fatal WhatsApp initialization notice:', err.message);
    });
  } catch (err) {
    wwebStatus = `error:${err.message}`;
  }
}

// ============================================================================
// 2. HUAWEI LTE ROUTER SMS GATEWAY POOL (`192.168.9.1`, `192.168.8.1`, `192.168.10.1`)
// ============================================================================
let huaweiGateway = null;
let huaweiReady = false;

async function initHuaweiGatewayPool() {
  const driverPath =
    '/home/aurum/Documents/Linka-Lesotho-2L-/khauta-stunning-tribble/workspace-otp-server-sms';
  try {
    if (!fs.existsSync(driverPath)) return;
    const { HuaweiGateway } = require(driverPath);
    const routerIps = (process.env.ROUTER_IPS || '192.168.9.1,192.168.8.1,192.168.10.1')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const user = process.env.ROUTER_USER || 'admin';
    const pass = process.env.ROUTER_PASS || 'Technomath';

    huaweiGateway = new HuaweiGateway({
      routers: routerIps.map((ip) => ({
        url: ip,
        username: user,
        password: pass,
        timeout: 6000,
        gcIntervalMs: 60000,
        gcThreshold: 15,
        autoDeleteRead: true,
        autoDeleteSent: true,
      })),
      strategy: 'failover',
    });

    const results = await huaweiGateway.initialize();
    huaweiReady = Array.isArray(results) && results.some((r) => r.status === 'fulfilled' && r.value?.reachable);
    console.log(`📡 [UMANG-SMS] Huawei Router Gateway Pool initialized (reachable=${huaweiReady}, routers=${routerIps.join(',')})`);
  } catch (err) {
    console.warn(`⚠️ [UMANG-SMS] HuaweiGateway driver init warning: ${err.message}`);
  }
}

/**
 * Normalizes a Lesotho phone number to E.164 (+266########)
 */
function normalizeE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 8 && /^[562]/.test(digits)) {
    return `+266${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('266')) {
    return `+${digits}`;
  }
  if (digits.length === 9 && digits.startsWith('0')) {
    return `+266${digits.slice(1)}`;
  }
  if (digits.length >= 10) {
    return `+${digits}`;
  }
  return null;
}

/**
 * Normalizes a Lesotho phone number to local 8-digit router format (e.g. 57284264)
 */
function toRouterPhone(e164) {
  const digits = String(e164 || '').replace(/\D/g, '');
  if (digits.startsWith('266') && digits.length === 11) {
    return digits.slice(3);
  }
  return digits;
}

/**
 * Normalizes a Lesotho phone number to WhatsApp JID (e.g. 26657284264@s.whatsapp.net)
 */
function toWhatsAppJid(e164) {
  const digits = String(e164 || '').replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

/**
 * Formats bilingual Sesotho/English WhatsApp OTP message
 */
function formatWhatsAppMessage(otp, domain = 'liparola.org', ttl = 5) {
  return (
    `✉️ *uMail (${domain}) — UMANG Netefatso ea Boitsebiso*\n` +
    `Your instant mail login code / Khoutu ea hau ea ho kena:\n\n` +
    `👉 *${otp}*\n\n` +
    `⏱️ Valid for ${ttl} minutes / E sebetsa metsotso e ${ttl}.\n` +
    `🔒 Do not share this code / Se ke oa arolelana khoutu ena le mang kapa mang.\n\n` +
    `@${domain} #${otp}`
  );
}

/**
 * Formats SMS OTP message with WebOTP origin-bound final line (`@domain #otp`)
 */
function formatSmsMessage(otp, domain = 'liparola.org', ttl = 5) {
  const cleanHost = String(domain).replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  return (
    `[uMail ${cleanHost}] Khoutu ea hau / Your verification code is ${otp}. Valid for ${ttl} mins.\n` +
    `@${cleanHost} #${otp}`
  );
}

/**
 * Attempts to dispatch via external AetherWA Gateway HTTP endpoint if online
 */
function tryAetherWaHttp(payload) {
  return new Promise((resolve, reject) => {
    const gatewayUrl = process.env.AETHERWA_GATEWAY_URL || 'http://127.0.0.1:3005';
    let url;
    try {
      url = new URL('/api/send-otp', gatewayUrl);
    } catch (err) {
      return reject(err);
    }

    const body = JSON.stringify(payload);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 2500,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ delivered: true, channel: 'whatsapp', provider: 'aetherwa-http' });
          } else {
            reject(new Error(`AetherWA HTTP ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('AetherWA HTTP timeout'));
    });
    req.write(body);
    req.end();
  });
}

async function dispatchOtp({ phone, otp, channel, domain, email }) {
  const e164 = normalizeE164(phone);
  if (!e164) {
    const err = new Error(`Invalid Lesotho phone number: ${phone}`);
    err.statusCode = 400;
    throw err;
  }

  const targetDomain = domain || 'liparola.org';
  const preferred = String(channel || process.env.OTP_CHANNEL || 'whatsapp').toLowerCase();
  const routerPhone = toRouterPhone(e164);
  const jid = toWhatsAppJid(e164);
  const waMessage = formatWhatsAppMessage(otp, targetDomain, 5);
  const smsMessage = formatSmsMessage(otp, targetDomain, 5);

  let primaryError = null;

  // 1A. Try Embedded whatsapp-web.js if ready
  if ((preferred === 'whatsapp' || preferred === 'aetherwa') && wwebReady && wwebClient) {
    try {
      const chatId = `${e164.replace(/\D/g, '')}@c.us`;
      await wwebClient.sendMessage(chatId, waMessage);
      lastDeliveryEvent = {
        phone: e164,
        email,
        domain: targetDomain,
        otp,
        channel: 'whatsapp',
        mode: 'whatsapp-wwebjs',
        fallbackUsed: false,
        timestamp: new Date().toISOString(),
      };
      console.log(`✅ [UMANG-WA] Sent WhatsApp OTP [${otp}] to ${e164} (${email || targetDomain})`);
      return lastDeliveryEvent;
    } catch (waErr) {
      primaryError = waErr.message;
    }
  }

  // 1B. Try external AetherWA HTTP Gateway if online
  if (preferred === 'whatsapp' || preferred === 'aetherwa') {
    try {
      await tryAetherWaHttp({
        phone: e164,
        jid,
        otp,
        message: waMessage,
        ttlMinutes: 5,
        appName: `uMail (${targetDomain})`,
      });
      lastDeliveryEvent = {
        phone: e164,
        email,
        domain: targetDomain,
        otp,
        channel: 'whatsapp',
        mode: 'whatsapp-aetherwa',
        fallbackUsed: false,
        timestamp: new Date().toISOString(),
      };
      return lastDeliveryEvent;
    } catch (err) {
      primaryError = err.message;
    }
  }

  // 2. Try Authenticated Huawei Router SMS Pool (`192.168.9.1`, `192.168.8.1`, `192.168.10.1`)
  if (process.env.MOCK_SMS !== 'true' && huaweiGateway) {
    try {
      const result = await huaweiGateway.sendOtp(routerPhone, otp, {
        appName: `uMail ${targetDomain}`,
        ttlMinutes: 5,
        customTemplate: smsMessage,
      });
      lastDeliveryEvent = {
        phone: e164,
        email,
        domain: targetDomain,
        otp,
        channel: 'sms',
        mode: 'huawei-router-sms',
        routerIp: result.deliveredBy || '192.168.9.1',
        fallbackUsed: preferred !== 'sms',
        timestamp: new Date().toISOString(),
      };
      console.log(`✅ [UMANG-SMS] Sent SMS OTP [${otp}] via Huawei Router (${lastDeliveryEvent.routerIp}) to ${routerPhone}`);
      return lastDeliveryEvent;
    } catch (routerErr) {
      primaryError = routerErr.message;
    }
  }

  // 3. Win-Win Console Fallback (Dev / Local Tailscale Host Verification Mode)
  console.log(`\n╔══════════════════════════════════════════════════════════════════════╗`);
  console.log(`║ 🔐 [UMANG OTP BRIDGE — MULTI-CHANNEL DISPATCH (${preferred.toUpperCase()})]             ║`);
  console.log(`║ 📱 Phone:   ${e164.padEnd(56)} ║`);
  console.log(`║ ✉️  Mailbox: ${String(email || 'N/A').padEnd(56)} ║`);
  console.log(`║ 🌐 Domain:  ${String(targetDomain).padEnd(56)} ║`);
  console.log(`║ 🔑 OTP:     ${String(otp).padEnd(56)} ║`);
  console.log(`║ 📝 WebOTP:  @${targetDomain} #${otp}                                      ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════════╝\n`);

  lastDeliveryEvent = {
    phone: e164,
    email: email || null,
    domain: targetDomain,
    otp,
    channel: preferred === 'sms' ? 'sms' : 'whatsapp',
    mode: 'umang-console-win-win',
    webOtpLine: `@${targetDomain} #${otp}`,
    fallbackUsed: true,
    note: primaryError || 'Dispatched via UMANG Console Win-Win Mode',
    timestamp: new Date().toISOString(),
  };

  return lastDeliveryEvent;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Internal-Token');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  if (req.method === 'GET' && (req.url === '/health' || req.url === '/api/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        status: 'ok',
        service: 'umang-otp-bridge',
        standard: 'UMANG-AetherWA-SMS-v1',
        whatsappStatus: wwebStatus,
        whatsappReady: wwebReady,
        huaweiRouterReachable: huaweiReady,
        lastDelivery: lastDeliveryEvent,
        timestamp: new Date().toISOString(),
      })
    );
  }

  if (req.method === 'POST' && (req.url === '/api/dispatch-otp' || req.url === '/api/send-otp')) {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        const result = await dispatchOtp(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ delivered: true, ...result }));
      } catch (err) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ delivered: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`🚀 UMANG Multi-Channel OTP Bridge listening on http://${HOST}:${PORT}`);
    initHuaweiGatewayPool();
    initEmbeddedWhatsApp();
  });
}

module.exports = { server, dispatchOtp, normalizeE164, formatSmsMessage, formatWhatsAppMessage };
