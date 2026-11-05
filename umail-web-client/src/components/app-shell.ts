import { LitElement, html, css } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { router } from '../router/index';
import { detectTenantDomain } from '../services/auth';
import './core-viewport';
import './nav-trigger';
import './profile-expander';
import './splash-screen';
import './compose-modal';
import type { ComposeModal } from './compose-modal';

const icons = {
  inbox: html`<span class="material-icons notranslate">inbox</span>`,
  starred: html`<span class="material-icons notranslate">star_outline</span>`,
  sent: html`<span class="material-icons notranslate">send</span>`,
  archive: html`<span class="material-icons notranslate">inventory_2</span>`,
  trash: html`<span class="material-icons notranslate">delete_outline</span>`,
  dns: html`<span class="material-icons notranslate">dns</span>`,
  compose: html`<span class="material-icons notranslate">edit</span>`
};

@customElement('app-shell')
export class AppShell extends LitElement {
  @state() private _drawerOpen = false;
  @state() private _currentView = 'inbox';
  @state() private _booting = true;

  @query('compose-modal') private _composeModal?: ComposeModal;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      background: #f5f5f5;
      color: #333;
    }

    .material-icons {
      font-family: 'Material Icons';
      font-weight: normal;
      font-style: normal;
      font-size: 22px;
      line-height: 1;
      letter-spacing: normal;
      text-transform: none;
      display: inline-block;
      white-space: nowrap;
      word-wrap: normal;
      direction: ltr;
      -webkit-font-feature-settings: 'liga';
      font-feature-settings: 'liga';
      -webkit-font-smoothing: antialiased;
    }

    header {
      display: flex;
      align-items: center;
      padding: 0 16px;
      height: 64px;
      background: #fff;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.08);
      z-index: 10;
    }

    h1 {
      flex: 1;
      font-size: 1.2rem;
      margin: 0;
      font-weight: 600;
      margin-left: 12px;
      color: #1a1a2e;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .domain-tag {
      font-size: 0.75rem;
      background: #f3ebff;
      color: #6200ee;
      padding: 3px 10px;
      border-radius: 14px;
      font-weight: 700;
    }

    .main-container {
      display: flex;
      flex: 1;
      overflow: hidden;
      position: relative;
    }

    nav {
      width: 256px;
      background: #fff;
      border-right: 1px solid #e0e0e0;
      display: flex;
      flex-direction: column;
      transition: transform 0.3s ease;
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      z-index: 5;
      transform: translateX(-100%);
      padding-top: 12px;
    }

    nav.open {
      transform: translateX(0);
      box-shadow: 2px 0 8px rgba(0, 0, 0, 0.1);
    }

    @media (min-width: 768px) {
      nav {
        position: relative;
        transform: translateX(0);
      }
    }

    .compose-fab {
      margin: 4px 16px 14px 16px;
      padding: 12px 18px;
      background: #6200ee;
      color: #fff;
      border: none;
      border-radius: 12px;
      font-weight: 600;
      font-size: 0.95rem;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(98, 0, 238, 0.25);
      transition: background 0.2s;
    }

    .compose-fab:hover {
      background: #3700b3;
    }

    .nav-item {
      display: flex;
      align-items: center;
      padding: 13px 24px;
      text-decoration: none;
      color: #555;
      font-weight: 500;
      font-size: 0.93rem;
      cursor: pointer;
    }

    .nav-item:hover {
      background: #f0f0f0;
    }

    .nav-item.active {
      color: #6200ee;
      background: #f5f5ff;
      font-weight: 600;
      border-right: 3px solid #6200ee;
    }

    .nav-item .material-icons {
      margin-right: 12px;
    }

    core-viewport {
      flex: 1;
      overflow: hidden;
    }

    .scrim {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 4;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s;
    }
    .scrim.open {
      opacity: 1;
      pointer-events: auto;
    }
    @media (min-width: 768px) {
      .scrim {
        display: none;
      }
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    router.addEventListener('route-changed', (e: Event) => {
      this._currentView = (e as CustomEvent).detail.view;
      this._drawerOpen = false;
    });
    router.resolveRoute();

    this.addEventListener('open-compose', (e: Event) => {
      const detail = (
        e as CustomEvent<{
          to?: string;
          subject?: string;
          body?: string;
          inReplyTo?: string;
          threadId?: string;
        }>
      ).detail;
      this._composeModal?.open(
        detail?.to ?? '',
        detail?.subject ?? '',
        detail?.body ?? '',
        detail?.inReplyTo ?? '',
        detail?.threadId ?? ''
      );
    });

    setTimeout(() => {
      this._booting = false;
    }, 900);
  }

  private _toggleDrawer() {
    this._drawerOpen = !this._drawerOpen;
  }

  private _handleMenuToggle(e: CustomEvent) {
    this._drawerOpen = e.detail.isOpen;
  }

  private _nav(view: string) {
    router.navigate(`app://${view}`);
  }

  render() {
    const isAuthRoute = ['login', 'otp', 'signup'].includes(this._currentView);
    const domain = detectTenantDomain();

    if (isAuthRoute) {
      return html`
        <splash-screen ?hidden=${!this._booting}></splash-screen>
        <core-viewport></core-viewport>
      `;
    }

    return html`
      <splash-screen ?hidden=${!this._booting}></splash-screen>

      <header>
        <nav-trigger .isOpen=${this._drawerOpen} @menu-toggle=${this._handleMenuToggle}></nav-trigger>
        <h1>
          uMail
          <span class="domain-tag">@${domain}</span>
        </h1>
        <profile-expander></profile-expander>
      </header>

      <div class="main-container">
        <div class="scrim ${this._drawerOpen ? 'open' : ''}" @click=${this._toggleDrawer}></div>

        <nav class="${this._drawerOpen ? 'open' : ''}" aria-label="Mailbox folders">
          <button class="compose-fab" @click=${() => this._composeModal?.open()}>
            ${icons.compose} Compose
          </button>

          <a
            class="nav-item ${this._currentView === 'inbox' ? 'active' : ''}"
            @click=${() => this._nav('inbox')}>
            ${icons.inbox} Inbox
          </a>
          <a
            class="nav-item ${this._currentView === 'starred' ? 'active' : ''}"
            @click=${() => this._nav('starred')}>
            ${icons.starred} Starred
          </a>
          <a
            class="nav-item ${this._currentView === 'sent' ? 'active' : ''}"
            @click=${() => this._nav('sent')}>
            ${icons.sent} Sent Mail
          </a>
          <a
            class="nav-item ${this._currentView === 'archive' ? 'active' : ''}"
            @click=${() => this._nav('archive')}>
            ${icons.archive} Archive
          </a>
          <a
            class="nav-item ${this._currentView === 'trash' ? 'active' : ''}"
            @click=${() => this._nav('trash')}>
            ${icons.trash} Trash
          </a>
          <a
            class="nav-item ${this._currentView === 'domain-info' ? 'active' : ''}"
            @click=${() => this._nav('domain-info')}>
            ${icons.dns} Domain &amp; DNS
          </a>
        </nav>

        <core-viewport></core-viewport>
      </div>

      <compose-modal></compose-modal>
    `;
  }
}
