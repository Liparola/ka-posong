const path = require('path');

const ROOT_DIR = __dirname;

module.exports = {
  apps: [
    {
      name: 'kaposong-umang-otp-bridge',
      script: path.join(ROOT_DIR, 'umang-otp-bridge/src/server.js'),
      cwd: path.join(ROOT_DIR, 'umang-otp-bridge'),
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
        UMANG_BRIDGE_PORT: '3001',
        ROUTER_IPS: '192.168.9.1,192.168.8.1,192.168.10.1',
        ROUTER_USER: 'admin',
        ROUTER_PASS: 'Technomath',
        WWEBJS_AUTH_PATH:
          '/home/aurum/Documents/Projects/Business/Liparola FC/ka.sesiung/workspace-otp-server/.wwebjs_auth',
      },
      out_file: path.join(ROOT_DIR, 'logs/umang-otp-bridge.log'),
      error_file: path.join(ROOT_DIR, 'logs/umang-otp-bridge.log'),
      merge_logs: true,
    },
    {
      name: 'kaposong-rust-control-plane',
      script: path.join(ROOT_DIR, 'rust-control-plane/target/debug/rust-control-plane'),
      cwd: path.join(ROOT_DIR, 'rust-control-plane'),
      interpreter: 'none',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      env: {
        PORT: '8443',
        SECONDARY_PORT: '3000',
        DATABASE_URL: `sqlite://${path.join(ROOT_DIR, 'rust-control-plane/control_plane.db')}?mode=rwc`,
        UMANG_OTP_BRIDGE_URL: 'http://127.0.0.1:3001',
        PRIMARY_MAIL_HOSTNAME: 'aurum-thinkpad-t440p.tail8fafd0.ts.net',
        MASTER_DEVOPS_KEY: 'devops-master-key',
        BRIDGE_SECRET: 'cf-tunnel-secret',
        ALLOW_DEV_OTP_PREVIEW: 'true',
        // Outbound HTTPS Email Relay (Port 443 — bypasses ISP/VPN Port 25/587 blocks):
        // Set OUTBOUND_WORKER_URL to your Cloudflare Worker URL (e.g. 'https://kaposong-email-ingress.<subdomain>.workers.dev/send-email')
        // or set RESEND_API_KEY / BREVO_API_KEY:
        OUTBOUND_WORKER_URL: process.env.OUTBOUND_WORKER_URL || '',
        RESEND_API_KEY: process.env.RESEND_API_KEY || '',
        BREVO_API_KEY: process.env.BREVO_API_KEY || '',
      },
      out_file: path.join(ROOT_DIR, 'logs/rust-control-plane.log'),
      error_file: path.join(ROOT_DIR, 'logs/rust-control-plane.log'),
      merge_logs: true,
    },
  ],
};
