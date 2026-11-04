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
  @state() private phone = '57284264';
  @state() private channel: 'whatsapp' | 'sms' = 'whatsapp';
  @state() private error = '';
  @state() private loading = false;

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
    .quick-accounts {
      text-align: left;
      background: #f9f9fc;
      border: 1px dashed #d5d0e8;
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 18px;
      font-size: 0.78rem;
      color: #555;
    }
    .quick-accounts strong {
      display: block;
      color: #333;
      margin-bottom: 6px;
    }
    .pill-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .acct-pill {
      background: #fff;
      border: 1px solid #d0c4f7;
      color: #6200ee;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 0.75rem;
      cursor: pointer;
      font-weight: 600;
    }
    .acct-pill:hover {
      background: #6200ee;
      color: #fff;
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

  private selectQuickPhone(digits: string) {
    this.phone = digits;
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
      if (resp.dev_otp_preview || resp.email_hint) {
        sessionStorage.setItem(
          PENDING_OTP_HINT_KEY,
          JSON.stringify({
            email: resp.email_hint,
            channel: resp.channel,
            otpPreview: resp.dev_otp_preview
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

  private navToSignup(e: Event) {
    e.preventDefault();
    router.navigate('app://signup');
  }

  render() {
    const domain = detectTenantDomain();
    return html`
      <div class="card">
        <div class="tenant-badge">uMail • ${domain}</div>
        <h2>Instant Phone Sign-In</h2>
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
                placeholder="57284264"
                .value="${this.phone}"
                @input="${this.handleInput}"
                autocomplete="tel-local"
                ?disabled="${this.loading}"
              />
            </div>
            <div class="error">${this.error}</div>
          </div>

          <div class="channel-selector" role="group" aria-label="OTP Delivery Channel">
            <button
              type="button"
              class="channel-btn ${this.channel === 'whatsapp' ? 'active' : ''}"
              @click=${() => (this.channel = 'whatsapp')}>
              💬 WhatsApp OTP
            </button>
            <button
              type="button"
              class="channel-btn ${this.channel === 'sms' ? 'active' : ''}"
              @click=${() => (this.channel = 'sms')}>
              📱 SMS Gateway
            </button>
          </div>

          <div class="quick-accounts">
            <strong>Provisioned @${domain} Test Identities:</strong>
            <div class="pill-row">
              <button type="button" class="acct-pill" @click=${() => this.selectQuickPhone('57284264')}>
                +266 57284264 (admin@liparola.org)
              </button>
              <button type="button" class="acct-pill" @click=${() => this.selectQuickPhone('57893042')}>
                +266 57893042 (khahliso@liparola.org)
              </button>
              <button type="button" class="acct-pill" @click=${() => this.selectQuickPhone('58088117')}>
                +266 58088117 (info@liparola.org)
              </button>
            </div>
          </div>

          <button
            type="submit"
            class="submit-btn"
            ?disabled="${this.phone.length !== 8 || this.loading}">
            ${this.loading ? 'Dispatching UMANG OTP...' : 'Send Instant OTP'}
          </button>
        </form>

        <div class="footer">
          First time accessing your organization inbox?
          <a @click="${this.navToSignup}">Activate Inbox</a>
        </div>
      </div>
    `;
  }
}
