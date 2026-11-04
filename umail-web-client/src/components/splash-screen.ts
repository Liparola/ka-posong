import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('splash-screen')
export class SplashScreen extends LitElement {
  @property({ type: Boolean }) visible = true;

  static styles = css`
    :host {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: #ffffff;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      transition: opacity 0.6s ease-out, visibility 0.6s;
      opacity: 1;
      visibility: visible;
    }
    :host([hidden]) {
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
    }

    .logo-container {
      width: 110px;
      height: 110px;
      animation: pulse 2s infinite ease-in-out;
    }

    svg {
      width: 100%;
      height: 100%;
    }

    .brand-title {
      margin-top: 16px;
      font-size: 1.35rem;
      font-weight: 700;
      color: #6200ee;
      letter-spacing: 0.04em;
    }

    .brand-sub {
      font-size: 0.82rem;
      color: #777;
      margin-top: 4px;
    }

    @keyframes pulse {
      0% { transform: scale(0.95); opacity: 0.85; }
      50% { transform: scale(1.05); opacity: 1; }
      100% { transform: scale(0.95); opacity: 0.85; }
    }

    .loading-bar {
      position: absolute;
      bottom: 18%;
      width: 200px;
      height: 4px;
      background: #f0f0f0;
      border-radius: 2px;
      overflow: hidden;
    }

    .loading-progress {
      height: 100%;
      background: #6200ee;
      width: 0%;
      animation: load 1.2s ease-out forwards;
    }

    @keyframes load {
      0% { width: 0%; }
      40% { width: 50%; }
      100% { width: 100%; }
    }
  `;

  render() {
    return html`
      <div class="logo-container">
        <svg viewBox="0 0 100 100">
          <rect width="100" height="100" rx="22" fill="#6200ee" />
          <path d="M20 30 H80 V70 H20 Z" fill="none" stroke="#ffffff" stroke-width="6" stroke-linejoin="round" />
          <path d="M20 32 L50 54 L80 32" fill="none" stroke="#ffd700" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <div class="brand-title">uMail • ka-posong</div>
      <div class="brand-sub">Liparola Instant Business Mail &amp; UMANG Identity</div>
      <div class="loading-bar">
        <div class="loading-progress"></div>
      </div>
    `;
  }
}
