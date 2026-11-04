import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { router } from '../router/index';
import { authService, ClientInfo } from '../services/auth';

@customElement('profile-expander')
export class ProfileExpander extends LitElement {
  @state() private isExpanded = false;
  @state() private user: ClientInfo | null = authService.getUser();

  private _authHandler!: (e: Event) => void;

  static styles = css`
    :host { display: block; }
    .profile-container {
      position: relative;
      width: 100%;
    }
    .avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      overflow: hidden;
      cursor: pointer;
      background: #eee;
      border: 2px solid transparent;
      transition: border-color 0.2s;
    }
    .avatar:hover {
      border-color: #6200ee;
    }
    .avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .details {
      max-height: 0;
      opacity: 0;
      overflow: hidden;
      transition: all 0.3s ease;
      background: white;
      border-radius: 12px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
      position: absolute;
      top: 50px;
      right: 0;
      width: 280px;
      z-index: 100;
    }
    .details.open {
      max-height: 320px;
      opacity: 1;
      padding: 16px;
    }
    h3 { margin: 0 0 4px 0; font-size: 1rem; color: #1a1a2e; }
    .email-pill {
      margin: 4px 0;
      font-size: 0.85rem;
      color: #6200ee;
      font-weight: 600;
      word-break: break-all;
    }
    p { margin: 4px 0; font-size: 0.85rem; color: #555; }
    .badge {
      display: inline-block;
      font-size: 0.72rem;
      padding: 2px 8px;
      background: #ffd700;
      color: #333;
      border-radius: 10px;
      font-weight: bold;
      margin-bottom: 8px;
      text-transform: uppercase;
    }
    small { display: block; margin-top: 6px; color: #888; font-size: 0.75rem; }
    .sign-out-btn {
      display: block;
      width: 100%;
      margin-top: 12px;
      padding: 8px 0;
      background: transparent;
      border: 1px solid #d32f2f;
      border-radius: 6px;
      color: #d32f2f;
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s, color 0.2s;
    }
    .sign-out-btn:hover {
      background: #d32f2f;
      color: white;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this._authHandler = (e: Event) => {
      this.user = (e as CustomEvent<{ user: ClientInfo | null }>).detail.user;
      this.isExpanded = false;
    };
    authService.addEventListener('auth-changed', this._authHandler);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    authService.removeEventListener('auth-changed', this._authHandler);
  }

  private _handleSignOut() {
    this.isExpanded = false;
    authService.signOut();
    router.navigate('app://login');
  }

  private _avatarUrl(name: string) {
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=6200ee&color=fff`;
  }

  render() {
    const name = this.user?.name ?? 'uMail Client';
    const email = this.user?.email ?? '—';
    const phone = this.user?.phone ?? '';
    const clientId = this.user?.clientId ?? '—';
    const domain = this.user?.domain ?? 'liparola.org';

    return html`
      <div class="profile-container">
        <div
          class="avatar"
          @click="${() => (this.isExpanded = !this.isExpanded)}"
          role="button"
          aria-label="Profile menu">
          <img src="${this._avatarUrl(name)}" alt="Profile" />
        </div>

        <div class="details ${this.isExpanded ? 'open' : ''}">
          <h3>${name}</h3>
          <span class="badge">UMANG Verified • ${domain}</span>
          <div class="email-pill">${email}</div>
          <p>Phone ID: <strong>${phone}</strong></p>
          <small>Tenant ID: ${clientId}</small>
          <button class="sign-out-btn" @click="${this._handleSignOut}">Sign Out of uMail</button>
        </div>
      </div>
    `;
  }
}
