/// <reference types="vite/client" />

/**
 * AuthService — UMANG Core OIDC + Phone-First OTP & JWT Session Client for uMail
 *
 * Connects ka-posong's uMail PWA to UMANG Core (`tnt_ka_posong`, `umang_pk_ka_posong`)
 * using either:
 *  1. Direct tenant-scoped Phone+OTP flow (`/api/auth/request-otp` -> `/api/auth/verify-otp`)
 *  2. Standards-compliant OAuth 2.0 / OIDC + PKCE (S256) flow (`/sso/authorize` -> `/api/auth/sso-exchange`)
 */

export interface ClientInfo {
  phone: string;
  email: string;
  clientId: string;
  umangTenantId?: string;
  name: string;
  domain: string;
  role?: 'owner' | 'manager' | 'viewer' | 'admin' | 'user';
  access?: 'full' | 'standard' | 'read-only';
  subscription?: string;
  planId?: string;
  subscribed_to_whatsapp_otp?: boolean;
  status?: 'active' | 'inactive';
}

export interface OtpDispatchResponse {
  message: string;
  phone: string;
  email_hint?: string;
  domain?: string;
  channel?: string;
  delivery_mode?: string;
  umang_tenant_id?: string;
  ttl_seconds?: number;
}

export interface UmangPublicConfig {
  status: string;
  umang_standard: string;
  umang_tenant_id: string;
  umang_client_id: string;
  integration_level: string;
  domain: string;
  sso_authorize_url: string;
  oidc_discovery_url: string;
  sdk_script_url?: string;
}

const TOKEN_KEY = 'umail_auth_token';
const USER_KEY = 'umail_auth_user';
const API_BASE_KEY = 'umail_api_base_url';
const SSO_PKCE_VERIFIER_KEY = 'umang_sso_pkce_verifier';
const SSO_STATE_KEY = 'umang_sso_state';

export const PENDING_PHONE_KEY = 'umail_pending_phone';
export const PENDING_OTP_HINT_KEY = 'umail_pending_otp_hint';

function resolveDefaultApiBase(): string {
  const saved = localStorage.getItem(API_BASE_KEY);
  if (saved) return saved;
  if (import.meta.env.VITE_API_BASE_URL) {
    return import.meta.env.VITE_API_BASE_URL;
  }
  if (import.meta.env.VITE_CONTROL_PLANE_URL) {
    return import.meta.env.VITE_CONTROL_PLANE_URL;
  }
  return window.location.origin;
}

export function detectTenantDomain(): string {
  const params = new URLSearchParams(window.location.search);
  const queryDomain = params.get('domain');
  if (queryDomain) return queryDomain.toLowerCase();

  const host = window.location.hostname.toLowerCase();
  if (host.includes('weekly-observer') || host.includes('karabomilling')) {
    return 'karabomilling.co.ls';
  }
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.endsWith('.ts.net') ||
    host.endsWith('.web.app') ||
    host.endsWith('.firebaseapp.com')
  ) {
    const envDomain = import.meta.env.VITE_TENANT_DOMAIN as string | undefined;
    if (envDomain && envDomain.trim()) {
      return envDomain.trim().toLowerCase();
    }
    return 'liparola.org';
  }
  return host.replace(/^www\./, '');
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generatePkcePair(): Promise<{ codeVerifier: string; codeChallenge: string; state: string }> {
  const randomBytes = new Uint8Array(32);
  window.crypto.getRandomValues(randomBytes);
  const codeVerifier = base64UrlEncode(randomBytes);

  const stateBytes = new Uint8Array(16);
  window.crypto.getRandomValues(stateBytes);
  const state = base64UrlEncode(stateBytes);

  const digest = await window.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(codeVerifier)
  );
  const codeChallenge = base64UrlEncode(new Uint8Array(digest));

  return { codeVerifier, codeChallenge, state };
}

class AuthService extends EventTarget {
  private _token: string | null = null;
  private _user: ClientInfo | null = null;

  constructor() {
    super();
    const token = localStorage.getItem(TOKEN_KEY);
    const user = localStorage.getItem(USER_KEY);
    if (token && user && !this._isExpired(token)) {
      this._token = token;
      this._user = JSON.parse(user) as ClientInfo;
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    }
  }

  getApiBase(): string {
    return resolveDefaultApiBase();
  }

  setApiBase(url: string): void {
    localStorage.setItem(API_BASE_KEY, url.trim().replace(/\/$/, ''));
  }

  isAuthenticated(): boolean {
    return this._token !== null && !this._isExpired(this._token);
  }

  getToken(): string | null {
    return this._token;
  }

  getUser(): ClientInfo | null {
    return this._user;
  }

  async fetchUmangConfig(): Promise<UmangPublicConfig> {
    const domain = detectTenantDomain();
    const res = await fetch(
      `${this.getApiBase()}/api/auth/umang-config?domain=${encodeURIComponent(domain)}`
    );
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error((body['error'] as string) ?? `UMANG config unavailable (${res.status})`);
    }
    return body as unknown as UmangPublicConfig;
  }

  async startUmangSsoLogin(): Promise<void> {
    const domain = detectTenantDomain();
    const config = await this.fetchUmangConfig();
    const { codeVerifier, codeChallenge, state } = await generatePkcePair();

    sessionStorage.setItem(SSO_PKCE_VERIFIER_KEY, codeVerifier);
    sessionStorage.setItem(SSO_STATE_KEY, state);

    const redirectUri = `${window.location.origin}/umail/login`;
    const authUrl = new URL(config.sso_authorize_url);
    authUrl.searchParams.set('client_id', config.umang_client_id);
    authUrl.searchParams.set('domain', domain);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid profile phone email');
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);

    window.location.assign(authUrl.toString());
  }

  async exchangeSsoCode(code: string, stateParam: string | null): Promise<void> {
    const expectedState = sessionStorage.getItem(SSO_STATE_KEY);
    const codeVerifier = sessionStorage.getItem(SSO_PKCE_VERIFIER_KEY);
    sessionStorage.removeItem(SSO_STATE_KEY);
    sessionStorage.removeItem(SSO_PKCE_VERIFIER_KEY);

    if (expectedState && stateParam !== expectedState) {
      throw new Error('UMANG SSO state mismatch. Please retry sign-in.');
    }

    const domain = detectTenantDomain();
    const redirectUri = `${window.location.origin}/umail/login`;

    const res = await fetch(`${this.getApiBase()}/api/auth/sso-exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier || undefined,
        redirect_uri: redirectUri,
        domain
      })
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error((body['error'] as string) ?? `UMANG SSO exchange failed (${res.status})`);
    }
    this._token = body['token'] as string;
    this._user = body['client'] as ClientInfo;
    localStorage.setItem(TOKEN_KEY, this._token);
    localStorage.setItem(USER_KEY, JSON.stringify(this._user));
    this._emit();
  }

  async requestOtp(phone: string, channel: 'whatsapp' | 'sms' = 'whatsapp'): Promise<OtpDispatchResponse> {
    const domain = detectTenantDomain();
    const res = await fetch(`${this.getApiBase()}/api/auth/request-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, domain, channel })
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error((body['error'] as string) ?? `OTP request failed (${res.status})`);
    }
    return body as unknown as OtpDispatchResponse;
  }

  async verifyOtp(phone: string, otp: string): Promise<void> {
    const domain = detectTenantDomain();
    const res = await fetch(`${this.getApiBase()}/api/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, otp, domain })
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error((body['error'] as string) ?? `OTP verification failed (${res.status})`);
    }
    this._token = body['token'] as string;
    this._user = body['client'] as ClientInfo;
    localStorage.setItem(TOKEN_KEY, this._token);
    localStorage.setItem(USER_KEY, JSON.stringify(this._user));
    this._emit();
  }

  async signOut(): Promise<void> {
    const activeToken = this._token;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    sessionStorage.removeItem(PENDING_PHONE_KEY);
    sessionStorage.removeItem(PENDING_OTP_HINT_KEY);
    sessionStorage.removeItem(SSO_PKCE_VERIFIER_KEY);
    sessionStorage.removeItem(SSO_STATE_KEY);
    this._token = null;
    this._user = null;
    this._emit();

    if (activeToken) {
      try {
        await fetch(`${this.getApiBase()}/api/auth/logout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${activeToken}`
          },
          body: JSON.stringify({ token: activeToken })
        });
      } catch {
        // Best-effort remote revocation; local session is already cleared
      }
    }
  }

  private _isExpired(token: string): boolean {
    try {
      const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(b64)) as { exp: number };
      return Date.now() >= payload.exp * 1000;
    } catch {
      return true;
    }
  }

  private _emit(): void {
    this.dispatchEvent(
      new CustomEvent<{ user: ClientInfo | null }>('auth-changed', {
        detail: { user: this._user }
      })
    );
  }
}

export const authService = new AuthService();
