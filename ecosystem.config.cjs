'use strict';

const fs = require('fs');
const path = require('path');

function loadDotEnv(filePath) {
  const envVars = {};
  if (!fs.existsSync(filePath)) return envVars;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    envVars[key] = val;
  }
  return envVars;
}

const ROOT_DIR = __dirname;
const dotEnv = loadDotEnv(path.join(ROOT_DIR, '.env'));

module.exports = {
  apps: [
    {
      name: 'kaposong-rust-control-plane',
      script: path.join(ROOT_DIR, 'rust-control-plane/target/release/rust-control-plane'),
      cwd: path.join(ROOT_DIR, 'rust-control-plane'),
      interpreter: 'none',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      env: {
        RUST_LOG: process.env.RUST_LOG || dotEnv.RUST_LOG || 'info,rust_control_plane=info',
        APP_ENV: process.env.APP_ENV || dotEnv.APP_ENV || 'production',
        HOST: process.env.HOST || dotEnv.HOST || '127.0.0.1',
        PORT: process.env.PORT || dotEnv.PORT || '8443',
        SECONDARY_PORT: process.env.SECONDARY_PORT || dotEnv.SECONDARY_PORT || '0',
        ALLOW_DEV_OTP_PREVIEW: process.env.ALLOW_DEV_OTP_PREVIEW || dotEnv.ALLOW_DEV_OTP_PREVIEW || 'false',
        ALLOW_LOCAL_OTP_FALLBACK: process.env.ALLOW_LOCAL_OTP_FALLBACK || dotEnv.ALLOW_LOCAL_OTP_FALLBACK || 'false',
        ALLOW_DETERMINISTIC_DKIM_FALLBACK:
          process.env.ALLOW_DETERMINISTIC_DKIM_FALLBACK || dotEnv.ALLOW_DETERMINISTIC_DKIM_FALLBACK || 'false',
        DATABASE_URL:
          process.env.DATABASE_URL ||
          dotEnv.DATABASE_URL ||
          `sqlite://${path.join(ROOT_DIR, 'rust-control-plane/control_plane.db')}?mode=rwc`,
        UMANG_CORE_URL: process.env.UMANG_CORE_URL || dotEnv.UMANG_CORE_URL || 'http://127.0.0.1:3000',
        UMANG_TENANT_ID: process.env.UMANG_TENANT_ID || dotEnv.UMANG_TENANT_ID || 'tnt_ka_posong',
        UMANG_CLIENT_ID: process.env.UMANG_CLIENT_ID || dotEnv.UMANG_CLIENT_ID || 'umang_pk_ka_posong',
        UMANG_API_KEY: process.env.UMANG_API_KEY || dotEnv.UMANG_API_KEY || '',
        UMANG_WEBHOOK_SECRET: process.env.UMANG_WEBHOOK_SECRET || dotEnv.UMANG_WEBHOOK_SECRET || '',
        PRIMARY_MAIL_HOSTNAME: process.env.PRIMARY_MAIL_HOSTNAME || dotEnv.PRIMARY_MAIL_HOSTNAME || '',
        UMAIL_STATIC_DIR:
          process.env.UMAIL_STATIC_DIR ||
          dotEnv.UMAIL_STATIC_DIR ||
          path.join(ROOT_DIR, 'umail-web-client/dist'),
        ...dotEnv,
      },
      out_file: path.join(ROOT_DIR, 'logs/rust-control-plane.log'),
      error_file: path.join(ROOT_DIR, 'logs/rust-control-plane.log'),
      merge_logs: true,
    },
  ],
};
