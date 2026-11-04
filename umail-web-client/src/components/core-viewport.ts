import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { router } from '../router/index';
import { authService, type ClientInfo } from '../services/auth';

import '../views/view-mailbox';
import '../views/view-domain-info';
import '../views/view-login';
import '../views/view-otp';
import '../views/view-signup';

const AUTH_ROUTES = ['login', 'otp', 'signup'];

@customElement('core-viewport')
export class CoreViewport extends LitElement {
  @state() private _currentView = 'inbox';
  private _authHandler!: (e: Event) => void;

  static styles = css`
    :host {
      display: block;
      height: 100%;
      overflow-y: auto;
      padding: 16px;
      box-sizing: border-box;
    }
  `;

  connectedCallback() {
    super.connectedCallback();

    router.addEventListener('route-changed', (e: Event) => {
      const view = (e as CustomEvent<{ view: string }>).detail.view;
      if (authService.isAuthenticated() && AUTH_ROUTES.includes(view)) {
        router.navigate('app://inbox');
        return;
      }
      if (!authService.isAuthenticated() && !AUTH_ROUTES.includes(view)) {
        router.navigate('app://login');
        return;
      }
      this._currentView = view;
      this.requestUpdate();
    });

    this._authHandler = (e: Event) => {
      this._onAuthChanged((e as CustomEvent<{ user: ClientInfo | null }>).detail.user);
    };
    authService.addEventListener('auth-changed', this._authHandler);

    this._onAuthChanged(authService.getUser());
    router.resolveRoute();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    authService.removeEventListener('auth-changed', this._authHandler);
  }

  private _onAuthChanged(user: ClientInfo | null) {
    if (user?.phone && user?.email) {
      if (AUTH_ROUTES.includes(this._currentView)) {
        router.navigate('app://inbox');
      }
    } else {
      if (!AUTH_ROUTES.includes(this._currentView)) {
        router.navigate('app://login');
      }
    }
  }

  private renderDynamicView() {
    switch (this._currentView) {
      case 'inbox':
      case 'starred':
      case 'sent':
      case 'archive':
      case 'trash':
        return html`<view-mailbox .folder=${this._currentView}></view-mailbox>`;
      case 'domain-info':
        return html`<view-domain-info></view-domain-info>`;
      case 'login':
        return html`<view-login></view-login>`;
      case 'otp':
        return html`<view-otp></view-otp>`;
      case 'signup':
        return html`<view-signup></view-signup>`;
      default:
        return html`<view-mailbox folder="inbox"></view-mailbox>`;
    }
  }

  render() {
    return html`${this.renderDynamicView()}`;
  }
}
