import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { router } from '../router/index';
import {
  authService,
  detectTenantDomain,
  PENDING_PHONE_KEY,
  PENDING_OTP_HINT_KEY
} from '../services/auth';

@customElement('view-signup')
export class ViewSignup extends LitElement {
  @state() private name = '';
  @state() private phone = '';
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
      border-top: 4px solid #6200ee;
    }
    h2 {
      margin-top: 0;
      color: #1a1a2e;
      text-align: center;
    }
    .info {
      font-size: 0.85rem;
      color: #666;
      text-align: center;
      margin-bottom: 22px;
      line-height: 1.5;
    }
    .input-group {
      display: flex;
      flex-direction: column;
      margin-bottom: 16px;
    }
    .input-group label {
      font-size: 0.85rem;
      font-weight: 600;
      margin-bottom: 6px;
      color: #444;
    }
    input {
      padding: 12px;
      border: 1px solid #ccc;
      border-radius: 8px;
      outline: none;
      font-size: 1rem;
    }
    .phone-input {
      display: flex;
      align-items: stretch;
      border: 1px solid #ccc;
      border-radius: 8px;
      overflow: hidden;
    }
    .prefix {
      background: #f0f0f5;
      padding: 12px;
      color: #444;
      font-weight: 600;
      border-right: 1px solid #ccc;
    }
    .phone-input input {
      border: none;
      flex: 1;
    }
    .error {
      color: #d32f2f;
      font-size: 0.82rem;
      margin-top: 6px;
      min-height: 18px;
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
    }
    button:disabled {
      background: #ccc;
      cursor: not-allowed;
    }
    .footer {
      margin-top: 20px;
      font-size: 0.88rem;
      color: #666;
      text-align: center;
    }
    .footer a {
      color: var(--primary-color, #6200ee);
      font-weight: 600;
      cursor: pointer;
    }
  `;

  private get isFormValid() {
    return this.name.trim().length >= 2 && this.phone.length === 8;
  }

  private async handleSubmit(e: Event) {
    e.preventDefault();
    if (!this.isFormValid) return;

    this.loading = true;
    this.error = '';
    const phoneNumber = '+266' + this.phone;

    try {
      const resp = await authService.requestOtp(phoneNumber, 'whatsapp');
      sessionStorage.setItem(PENDING_PHONE_KEY, phoneNumber);
      sessionStorage.setItem(
        PENDING_OTP_HINT_KEY,
        JSON.stringify({
          email: resp.email_hint,
          channel: resp.channel,
          otpPreview: resp.dev_otp_preview
        })
      );
      router.navigate('app://otp');
    } catch (err: unknown) {
      this.error = err instanceof Error ? err.message : 'Activation request failed.';
    } finally {
      this.loading = false;
    }
  }

  render() {
    const domain = detectTenantDomain();
    return html`
      <div class="card">
        <h2>Activate @${domain} Inbox</h2>
        <p class="info">
          uMail inboxes are provisioned by your organization administrator on the
          <strong>ka-posong</strong> Control Plane and tied to your Lesotho phone number.
        </p>

        <form @submit=${this.handleSubmit}>
          <div class="input-group">
            <label for="name">Full Name</label>
            <input
              id="name"
              type="text"
              placeholder="Khahliso Ramotoai"
              .value=${this.name}
              @input=${(e: Event) => (this.name = (e.target as HTMLInputElement).value)}
            />
          </div>

          <div class="input-group">
            <label for="phone">Registered Lesotho Phone Number</label>
            <div class="phone-input">
              <span class="prefix">+266</span>
              <input
                id="phone"
                type="tel"
                inputmode="numeric"
                placeholder="57284264"
                .value=${this.phone}
                @input=${(e: Event) => {
                  const t = e.target as HTMLInputElement;
                  const v = t.value.replace(/\D/g, '').slice(0, 8);
                  this.phone = v;
                  t.value = v;
                }}
              />
            </div>
          </div>

          <div class="error">${this.error}</div>

          <button type="submit" ?disabled=${!this.isFormValid || this.loading}>
            ${this.loading ? 'Verifying Provisioned Identity...' : 'Send Activation Code'}
          </button>
        </form>

        <div class="footer">
          Already activated?
          <a @click=${() => router.navigate('app://login')}>Sign In</a>
        </div>
      </div>
    `;
  }
}
