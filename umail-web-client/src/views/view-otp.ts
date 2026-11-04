import { LitElement, html, css } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { router } from '../router/index';
import {
  authService,
  PENDING_PHONE_KEY,
  PENDING_OTP_HINT_KEY
} from '../services/auth';

/**
 * view-otp — UMANG 6-digit OTP verification screen.
 *
 * Implements modern-web-guidance `sms-otp-form`:
 * - Single `<input type="text" inputmode="numeric" autocomplete="one-time-code" pattern="\d{6}" maxlength="6" required>`
 * - Instructional hint placed visually above the input (`aria-describedby="otp-format-hint"`)
 * - WebOTP API (`OTPCredential`) listener managed via `AbortController` across submit, resend, and unmount
 */
@customElement('view-otp')
export class ViewOtp extends LitElement {
  @state() private otp = '';
  @state() private error = '';
  @state() private loading = false;
  @state() private resendCountdown = 30;
  @state() private emailHint = '';
  @state() private otpPreview = '';

  @query('#otp-form') private otpForm?: HTMLFormElement;
  @query('#otp-input') private otpInput?: HTMLInputElement;

  private timer?: number;
  private pendingPhone = '';
  private otpAbortController: AbortController | null = null;

  static styles = css`
    :host {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100%;
      padding: 16px;
      box-sizing: border-box;
    }
    .card {
      background: var(--surface-color, #fff);
      border-radius: 14px;
      padding: 32px;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.1);
      text-align: center;
      border-top: 4px solid #6200ee;
    }
    h2 {
      margin-top: 0;
      color: #1a1a2e;
    }
    .email-target {
      display: inline-block;
      background: #f3ebff;
      color: #6200ee;
      font-weight: 700;
      font-size: 0.85rem;
      padding: 4px 12px;
      border-radius: 16px;
      margin-bottom: 12px;
    }
    .dev-banner {
      background: #fff8e1;
      border: 1px solid #ffe082;
      color: #5d4037;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 0.82rem;
      margin-bottom: 16px;
      cursor: pointer;
    }
    .input-group {
      display: flex;
      flex-direction: column;
      text-align: left;
      margin-bottom: 20px;
    }
    .input-group label {
      font-size: 0.9rem;
      font-weight: 600;
      margin-bottom: 4px;
      color: #333;
      text-align: center;
    }
    .field-hint {
      font-size: 0.84rem;
      color: #666;
      text-align: center;
      margin: 0 0 12px 0;
    }
    #otp-input {
      font-family: ui-monospace, monospace;
      font-size: 1.5rem;
      letter-spacing: 0.4em;
      min-height: 48px;
      padding: 0.5rem 0.75rem;
      box-sizing: border-box;
      border: 1px solid #ccc;
      border-radius: 8px;
      outline: none;
      text-align: center;
    }
    #otp-input:focus {
      border-color: var(--primary-color, #6200ee);
      background: #fafafa;
    }
    .error {
      color: #d32f2f;
      font-size: 0.85rem;
      margin-top: 8px;
      text-align: center;
      min-height: 20px;
    }
    button {
      width: 100%;
      padding: 14px;
      background: var(--primary-color, #6200ee);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.3s;
    }
    button:hover {
      background: #3700b3;
    }
    button:disabled {
      background: #ccc;
      cursor: not-allowed;
    }
    .resend {
      margin-top: 22px;
      font-size: 0.9rem;
      color: #666;
    }
    .resend button {
      background: transparent;
      color: var(--primary-color, #6200ee);
      width: auto;
      padding: 0;
      display: inline;
    }
    .resend button:hover {
      background: transparent;
      text-decoration: underline;
    }
    .resend button:disabled {
      color: #999;
      background: transparent;
      text-decoration: none;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.pendingPhone = sessionStorage.getItem(PENDING_PHONE_KEY) ?? '';
    if (!this.pendingPhone) {
      router.navigate('app://login');
      return;
    }

    const hintRaw = sessionStorage.getItem(PENDING_OTP_HINT_KEY);
    if (hintRaw) {
      try {
        const parsed = JSON.parse(hintRaw) as { email?: string; otpPreview?: string };
        this.emailHint = parsed.email ?? '';
        this.otpPreview = parsed.otpPreview ?? '';
      } catch {
        // ignore
      }
    }

    this.startTimer();
    this.startSmsOtpListener();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.timer) clearInterval(this.timer);
    this.stopSmsOtpListener();
  }

  private stopSmsOtpListener() {
    if (this.otpAbortController) {
      this.otpAbortController.abort();
      this.otpAbortController = null;
    }
  }

  private async startSmsOtpListener() {
    if (!('OTPCredential' in window)) {
      return;
    }
    this.stopSmsOtpListener();
    const ac = new AbortController();
    this.otpAbortController = ac;

    try {
      const cred = (await navigator.credentials.get({
        otp: { transport: ['sms'] },
        signal: ac.signal
      } as CredentialRequestOptions)) as { code?: string } | null;

      if (cred?.code) {
        this.otp = cred.code;
        if (this.otpInput) {
          this.otpInput.value = cred.code;
        }
        this.otpForm?.requestSubmit();
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
    }
  }

  private startTimer() {
    this.resendCountdown = 30;
    if (this.timer) clearInterval(this.timer);
    this.timer = window.setInterval(() => {
      if (this.resendCountdown > 0) {
        this.resendCountdown--;
      } else {
        clearInterval(this.timer);
      }
    }, 1000);
  }

  private handleInput(e: Event) {
    const target = e.target as HTMLInputElement;
    const val = target.value.replace(/\D/g, '');
    if (val.length <= 6) {
      this.otp = val;
      target.value = val;
    } else {
      target.value = this.otp;
    }
    this.error = '';
  }

  private fillDevOtp() {
    if (this.otpPreview) {
      this.otp = this.otpPreview;
    }
  }

  private async handleSubmit(e: Event) {
    e.preventDefault();
    this.stopSmsOtpListener();

    if (this.otp.length !== 6) {
      this.error = 'OTP must be 6 digits.';
      return;
    }
    if (!this.pendingPhone) {
      this.error = 'Session expired. Please try logging in again.';
      return;
    }

    this.loading = true;
    this.error = '';

    try {
      await authService.verifyOtp(this.pendingPhone, this.otp);
      sessionStorage.removeItem(PENDING_PHONE_KEY);
      sessionStorage.removeItem(PENDING_OTP_HINT_KEY);
      router.navigate('app://inbox');
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Invalid verification code. Please try again.';
      this.error = msg;
    } finally {
      this.loading = false;
    }
  }

  private async handleResend() {
    if (this.resendCountdown > 0 || !this.pendingPhone) return;
    this.loading = true;
    this.error = '';
    try {
      const resp = await authService.requestOtp(this.pendingPhone);
      if (resp.dev_otp_preview) {
        this.otpPreview = resp.dev_otp_preview;
      }
      this.startTimer();
      this.startSmsOtpListener();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Failed to resend. Please go back to login.';
      this.error = msg;
    } finally {
      this.loading = false;
    }
  }

  private goBack(e: Event) {
    e.preventDefault();
    this.stopSmsOtpListener();
    sessionStorage.removeItem(PENDING_PHONE_KEY);
    sessionStorage.removeItem(PENDING_OTP_HINT_KEY);
    router.navigate('app://login');
  }

  render() {
    return html`
      <div class="card">
        <h2>Verify UMANG OTP</h2>
        ${this.emailHint
          ? html`<div class="email-target">Inbox: ${this.emailHint}</div>`
          : ''}

        ${this.otpPreview
          ? html`
              <div class="dev-banner" @click=${this.fillDevOtp} title="Click to auto-fill OTP">
                🧪 <strong>UMANG Dev Console OTP:</strong> <code>${this.otpPreview}</code>
                <span style="text-decoration:underline; margin-left:4px;">(Tap to fill)</span>
              </div>
            `
          : ''}

        <form id="otp-form" method="POST" @submit="${this.handleSubmit}">
          <div class="input-group">
            <label for="otp-input">Verification Code</label>
            <p id="otp-format-hint" class="field-hint">
              Enter the 6-digit code sent to <strong>${this.pendingPhone}</strong>.<br />
              <a
                href="#"
                @click="${this.goBack}"
                style="color: var(--primary-color); text-decoration: none; font-size: 0.85rem;">
                Wrong phone number?
              </a>
            </p>
            <input
              type="text"
              id="otp-input"
              name="otp"
              inputmode="numeric"
              autocomplete="one-time-code"
              pattern="\\d{6}"
              maxlength="6"
              aria-describedby="otp-format-hint"
              placeholder="••••••"
              .value="${this.otp}"
              @input="${this.handleInput}"
              ?disabled="${this.loading}"
              required
            />
            <div class="error">${this.error}</div>
          </div>

          <button type="submit" ?disabled="${this.otp.length !== 6 || this.loading}">
            ${this.loading ? 'Opening Inbox...' : 'Verify & Open uMail Inbox'}
          </button>
        </form>

        <div class="resend">
          Didn't receive the code?
          <button
            type="button"
            @click="${this.handleResend}"
            ?disabled="${this.resendCountdown > 0 || this.loading}">
            ${this.resendCountdown > 0
              ? 'Resend in ' + this.resendCountdown + 's'
              : 'Resend Code'}
          </button>
        </div>
      </div>
    `;
  }
}
