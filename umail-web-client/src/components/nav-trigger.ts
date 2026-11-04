import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('nav-trigger')
export class NavTrigger extends LitElement {
  @property({ type: Boolean }) isOpen = false;

  static styles = css`
    :host { display: inline-block; }

    .mdc-icon-button {
      display: inline-flex;
      position: relative;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      width: 48px;
      height: 48px;
      padding: 12px;
      border: none;
      outline: none;
      background-color: transparent;
      fill: currentColor;
      color: inherit;
      font-size: 24px;
      text-decoration: none;
      cursor: pointer;
      user-select: none;
    }

    .material-icons {
      font-family: 'Material Icons';
      font-weight: normal;
      font-style: normal;
      font-size: 24px;
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

    .mat-mdc-button-ripple {
      position: absolute;
      top: 0;
      left: 0;
      bottom: 0;
      right: 0;
      border-radius: 50%;
      pointer-events: none;
    }

    .mdc-icon-button:hover .mat-mdc-button-ripple {
      background-color: rgba(0, 0, 0, 0.04);
    }
  `;

  private _toggleMenu() {
    this.isOpen = !this.isOpen;
    this.dispatchEvent(
      new CustomEvent('menu-toggle', {
        detail: { isOpen: this.isOpen },
        bubbles: true,
        composed: true
      })
    );
  }

  render() {
    return html`
      <button
        @click="${this._toggleMenu}"
        class="mdc-icon-button mat-mdc-icon-button mat-unthemed"
        aria-label="Main menu">
        <span class="mat-mdc-button-persistent-ripple mdc-icon-button__ripple"></span>
        <span class="material-icons notranslate">menu</span>
        <span class="mat-focus-indicator"></span>
        <span class="mat-ripple mat-mdc-button-ripple"></span>
      </button>
    `;
  }
}
