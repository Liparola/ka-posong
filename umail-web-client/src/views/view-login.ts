import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { router } from '../router/index';
import {
  authService,
  detectTenantDomain,
  PENDING_PHONE_KEY,
  PENDING_OTP_HINT_KEY
} from '../services/auth';

@customElement('view-login')
export class ViewLogin extends LitElement {
  @state() private phone = '';
  @state() private channel: 'whatsapp' | 'sms' = 'whatsapp';
  @state() private error = '';
  @state() private loading = false;
  @state() private ssoLoading = false;

  override connectedCallback() {
    super.connectedCallback();
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const stateParam = params.get('state');
    if (code) {
      this.ssoLoading = true;
      void this.handleSsoCallback(code, stateParam);
    }
  }

  private async handleSsoCallback(code: string, stateParam: string | null) {
    try {
      await authService.exchangeSsoCode(code, stateParam);
      window.history.replaceState({}, '', '/umail/inbox');
      router.navigate('app://inbox');
    } catch (err: unknown) {
      window.history.replaceState({}, '', '/umail/login');
      this.error = err instanceof Error ? err.message : 'UMANG SSO authentication failed.';
    } finally {
      this.ssoLoading = false;
    }
  }

  static styles = css`
    :host {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100%;
      padding: 16px;
      box-sizing: border-box;
      overflow-y: auto;
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
    .tenant-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #f3ebff;
      color: #6200ee;
      font-size: 0.78rem;
      font-weight: 700;
      padding: 4px 12px;
      border-radius: 20px;
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    h2 {
      margin: 0 0 6px 0;
      color: #1a1a2e;
      font-size: 1.45rem;
    }
    .subtext {
      color: #666;
      font-size: 0.9rem;
      margin-bottom: 22px;
    }
    .input-group {
      display: flex;
      flex-direction: column;
      text-align: left;
      margin-bottom: 18px;
    }
    .input-group label {
      font-size: 0.85rem;
      font-weight: 600;
      margin-bottom: 6px;
      color: #444;
    }
    .phone-input {
      display: flex;
      align-items: center;
      border: 1px solid #ccc;
      border-radius: 8px;
      overflow: hidden;
    }
    .phone-input:focus-within {
      border-color: #6200ee;
    }
    .prefix {
      background: #f0f0f5;
      padding: 12px 14px;
      color: #444;
      font-weight: 600;
      border-right: 1px solid #ccc;
    }
    input {
      flex: 1;
      padding: 12px;
      border: none;
      outline: none;
      font-size: 1.05rem;
      font-weight: 500;
      letter-spacing: 0.04em;
    }
    input:focus {
      background: #fafafa;
    }
    .channel-selector {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 18px;
    }
    .channel-btn {
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 8px;
      background: #fafafa;
      color: #555;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .channel-btn.active {
      border-color: #6200ee;
      background: #f5f0ff;
      color: #6200ee;
    }
    .error {
      color: #d32f2f;
      font-size: 0.85rem;
      margin-top: 6px;
      min-height: 20px;
    }
    button.submit-btn {
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
    button.submit-btn:hover {
      background: #3700b3;
    }
    button.submit-btn:disabled {
      background: #ccc;
      cursor: not-allowed;
    }
    .divider {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 18px 0 14px 0;
      color: #888;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .divider::before,
    .divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: #e2e2e9;
    }
    button.sso-btn {
      width: 100%;
      padding: 12px 14px;
      background: #0f172a;
      color: #ffffff;
      border: 1px solid #1e293b;
      border-radius: 8px;
      font-size: 0.92rem;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: background 0.2s;
    }
    button.sso-btn:hover {
      background: #1e293b;
    }
    button.sso-btn:disabled {
      opacity: 0.65;
      cursor: not-allowed;
    }
    .sso-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 5px;
      background: #10b981;
      color: #052e16;
      font-weight: 900;
      font-size: 0.78rem;
    }
    .footer {
      margin-top: 22px;
      font-size: 0.88rem;
      color: #666;
    }
    .footer a {
      color: var(--primary-color, #6200ee);
      text-decoration: none;
      font-weight: 600;
      cursor: pointer;
    }
    .footer a:hover {
      text-decoration: underline;
    }
  `;

  private handleInput(e: Event) {
    const target = e.target as HTMLInputElement;
    const val = target.value.replace(/\D/g, '');
    if (val.length <= 8) {
      this.phone = val;
      target.value = val;
    } else {
      target.value = this.phone;
    }
    this.error = '';
  }

  private async handleSubmit(e: Event) {
    e.preventDefault();
    if (this.phone.length !== 8) {
      this.error = 'Phone number must be exactly 8 Lesotho digits.';
      return;
    }

    this.loading = true;
    this.error = '';

    const phoneNumber = '+266' + this.phone;

    try {
      const resp = await authService.requestOtp(phoneNumber, this.channel);
      sessionStorage.setItem(PENDING_PHONE_KEY, phoneNumber);
      if (resp.email_hint || resp.channel) {
        sessionStorage.setItem(
          PENDING_OTP_HINT_KEY,
          JSON.stringify({
            email: resp.email_hint,
            channel: resp.channel
          })
        );
      }
      router.navigate('app://otp');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to send OTP. Try again.';
      this.error = msg;
    } finally {
      this.loading = false;
    }
  }

  private async handleUmangSso() {
    this.ssoLoading = true;
    this.error = '';
    try {
      await authService.startUmangSsoLogin();
    } catch (err: unknown) {
      this.error = err instanceof Error ? err.message : 'Unable to launch UMANG SSO.';
      this.ssoLoading = false;
    }
  }

  private navToSignup(e: Event) {
    e.preventDefault();
    router.navigate('app://signup');
  }

  render() {
    const domain = detectTenantDomain();
    const busy = this.loading || this.ssoLoading;

    return html`
      <div class="card">
        <div class="tenant-badge">uMail • ${domain}</div>
        <h2>${this.ssoLoading ? 'Completing UMANG SSO...' : 'Instant Phone Sign-In'}</h2>
        <p class="subtext">
          Enter your Lesotho phone number to receive a 6-digit UMANG OTP and open your
          <strong>@${domain}</strong> inbox.
        </p>

        <form @submit="${this.handleSubmit}">
          <div class="input-group">
            <label for="phone">Lesotho Phone Number (UMANG Identity)</label>
            <div class="phone-input">
              <span class="prefix">+266</span>
              <input
                id="phone"
                type="tel"
                inputmode="numeric"
                placeholder="5xxxxxxx"
                .value="${this.phone}"
                @input="${this.handleInput}"
                autocomplete="tel-local"
                ?disabled="${busy}"
              />
            </div>
            <div class="error">${this.error}</div>
          </div>

          <div class="channel-selector" role="group" aria-label="OTP Delivery Channel">
            <button
              type="button"
              class="channel-btn ${this.channel === 'whatsapp' ? 'active' : ''}"
              ?disabled="${busy}"
              @click=${() => (this.channel = 'whatsapp')}>
              💬 WhatsApp OTP
            </button>
            <button
              type="button"
              class="channel-btn ${this.channel === 'sms' ? 'active' : ''}"
              ?disabled="${busy}"
              @click=${() => (this.channel = 'sms')}>
              📱 SMS Gateway
            </button>
          </div>

          <button
            type="submit"
            class="submit-btn"
            ?disabled="${this.phone.length !== 8 || busy}">
            ${this.loading ? 'Dispatching UMANG OTP...' : 'Send Instant OTP'}
          </button>
        </form>

        <div class="divider">or federated oidc</div>

        <button
          type="button"
          class="sso-btn"
          ?disabled="${busy}"
          @click="${this.handleUmangSso}">
          <span class="sso-pill">U</span>
          ${this.ssoLoading ? 'Signing in via UMANG...' : 'Continue with UMANG SSO'}
        </button>

        <div class="footer">
          First time accessing your organization inbox?
          <a @click="${this.navToSignup}">Activate Inbox</a>
        </div>
      </div>
    `;
  }
}
