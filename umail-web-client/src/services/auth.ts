/// <reference types="vite/client" />

/**
 * AuthService — UMANG Phone-First OTP & JWT Session Client for uMail
 *
 * Follows the exact Liparola UMANG / Ka Sesiung Authentication Blueprint:
 * - Phone (+266########) is the primary identity key bound to a tenant mailbox.
 * - OTP is delivered via WhatsApp (AetherWA) or Huawei Router SMS.
 * - 8-hour JWT + ClientInfo stored in localStorage.
 */

export interface ClientInfo {
  phone: string;
  email: string;
  clientId: string;
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
  web_otp_hint?: string;
  dev_otp_preview?: string;
}

const TOKEN_KEY = 'umail_auth_token';
const USER_KEY = 'umail_auth_user';
const API_BASE_KEY = 'umail_api_base_url';

export const PENDING_PHONE_KEY = 'umail_pending_phone';
export const PENDING_OTP_HINT_KEY = 'umail_pending_otp_hint';

function resolveDefaultApiBase(): string {
  const saved = localStorage.getItem(API_BASE_KEY);
  if (saved) return saved;
  if (import.meta.env.VITE_CONTROL_PLANE_URL) {
    return import.meta.env.VITE_CONTROL_PLANE_URL;
  }
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.ts.net')) {
    return window.location.origin;
  }
  // When hosted on Firebase (https://liparola.org/umail), connect to the Tailscale Funnel Control Plane
  return 'https://aurum-thinkpad-t440p.tail8fafd0.ts.net';
}

export function detectTenantDomain(): string {
  const params = new URLSearchParams(window.location.search);
  const queryDomain = params.get('domain');
  if (queryDomain) return queryDomain.toLowerCase();

  const host = window.location.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.endsWith('.ts.net') ||
    host.endsWith('.web.app') ||
    host.endsWith('.firebaseapp.com')
  ) {
    return 'liparola.org';
  }
  return host.replace(/^www\./, '');
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

  signOut(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    sessionStorage.removeItem(PENDING_PHONE_KEY);
    sessionStorage.removeItem(PENDING_OTP_HINT_KEY);
    this._token = null;
    this._user = null;
    this._emit();
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
