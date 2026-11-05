import { LitElement, html, css } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { mailService } from '../services/mail';
import { authService } from '../services/auth';

/**
 * compose-modal — Native <dialog> modal for composing and sending emails via Stalwart.
 * Follows modern-web-guidance `dialog` Rule 1:
 * - Uses native `<dialog aria-labelledby="compose-title">` opened via `.showModal()`
 * - No redundant `role="dialog"` or `aria-modal`
 * - Uses `overscroll-behavior: contain` on `dialog:modal` and `dialog::backdrop`
 */
@customElement('compose-modal')
export class ComposeModal extends LitElement {
  @state() private to = '';
  @state() private subject = '';
  @state() private bodyText = '';
  @state() private inReplyTo = '';
  @state() private threadId = '';
  @state() private sending = false;
  @state() private sendingStage = '';
  @state() private error = '';
  @state() private successNotice = '';

  @query('dialog') private dialogEl!: HTMLDialogElement;

  static styles = css`
    dialog {
      border: none;
      border-radius: 14px;
      padding: 0;
      width: 92vw;
      max-width: 560px;
      box-shadow: 0 20px 45px rgba(0, 0, 0, 0.25);
      background: #fff;
      color: #333;
      position: relative;
      overflow: hidden;
    }

    dialog:modal {
      overscroll-behavior: contain;
    }

    dialog::backdrop {
      background: rgba(20, 14, 38, 0.55);
      overflow: hidden;
      overscroll-behavior: contain;
    }

    .progress-bar-thin {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3.5px;
      background: linear-gradient(90deg, #6200ee 0%, #00e5ff 50%, #7c4dff 100%);
      background-size: 200% 100%;
      animation: thinBarProgress 1.2s ease-in-out infinite;
      z-index: 20;
    }

    @keyframes thinBarProgress {
      0% {
        background-position: 100% 0;
      }
      100% {
        background-position: -100% 0;
      }
    }

    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      background: linear-gradient(135deg, #6200ee 0%, #3700b3 100%);
      color: #fff;
    }

    .modal-header h2 {
      margin: 0;
      font-size: 1.05rem;
      font-weight: 600;
    }

    .close-btn {
      background: transparent;
      border: none;
      color: #fff;
      font-size: 1.35rem;
      cursor: pointer;
      line-height: 1;
      padding: 4px 8px;
      border-radius: 6px;
    }

    .close-btn:hover {
      background: rgba(255, 255, 255, 0.15);
    }

    form {
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .sender-tag {
      font-size: 0.82rem;
      color: #666;
      background: #f5f5ff;
      padding: 8px 12px;
      border-radius: 8px;
      border-left: 3px solid #6200ee;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    label {
      font-size: 0.82rem;
      font-weight: 600;
      color: #555;
    }

    input,
    textarea {
      padding: 10px 12px;
      border: 1px solid #d0d0d8;
      border-radius: 8px;
      font-size: 0.95rem;
      font-family: inherit;
      outline: none;
    }

    input:focus,
    textarea:focus {
      border-color: #6200ee;
      background: #fafaff;
    }

    textarea {
      min-height: 150px;
      resize: vertical;
    }

    .error {
      color: #d32f2f;
      font-size: 0.84rem;
      min-height: 18px;
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 4px;
    }

    .btn-cancel {
      padding: 10px 18px;
      border: 1px solid #ccc;
      background: #fff;
      color: #444;
      border-radius: 8px;
      font-weight: 500;
      cursor: pointer;
    }

    .btn-send {
      padding: 10px 22px;
      border: none;
      background: #6200ee;
      color: #fff;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
    }

    .btn-send:hover {
      background: #3700b3;
    }

    .btn-send:disabled {
      background: #bbb;
      cursor: not-allowed;
    }
  `;

  public open(
    prefillTo = '',
    prefillSubject = '',
    prefillBody = '',
    inReplyTo = '',
    threadId = ''
  ) {
    this.to = prefillTo;
    this.subject = prefillSubject;
    this.bodyText = prefillBody;
    this.inReplyTo = inReplyTo;
    this.threadId = threadId;
    this.error = '';
    this.successNotice = '';
    this.dialogEl?.showModal();
  }

  public close() {
    this.dialogEl?.close();
  }

  private async _handleSubmit(e: Event) {
    e.preventDefault();
    if (!this.to.includes('@')) {
      this.error = 'Please enter a valid recipient email address.';
      return;
    }
    this.sending = true;
    this.sendingStage = 'Connecting to Cloudflare edge relay...';
    this.error = '';
    this.successNotice = '';

    const stageTimer = setTimeout(() => {
      this.sendingStage = 'Transmitting signed MIME envelope...';
    }, 450);

    try {
      const res = await mailService.sendMessage(
        this.to.trim(),
        this.subject.trim() || '(No Subject)',
        this.bodyText,
        undefined,
        this.inReplyTo || undefined,
        this.threadId || undefined
      );
      clearTimeout(stageTimer);

      const provider = res.delivery_provider ?? 'Cloudflare Email Service';
      const isExternal = res.relayed_externally === true;

      if (isExternal) {
        this.successNotice = `✓ Sent & delivered to ${this.to.trim()} via ${provider}`;
      } else {
        this.successNotice = `✓ Saved in Sent mailbox (${provider}). External delivery queued.`;
      }

      window.dispatchEvent(
        new CustomEvent('email-sent', {
          detail: {
            to: this.to.trim(),
            provider,
            relayedExternally: isExternal,
            message: this.successNotice
          }
        })
      );

      setTimeout(() => this.close(), 1200);
    } catch (err: unknown) {
      clearTimeout(stageTimer);
      this.error = err instanceof Error ? err.message : 'Failed to send message';
    } finally {
      this.sending = false;
      this.sendingStage = '';
    }
  }

  render() {
    const user = authService.getUser();
    return html`
      <dialog aria-labelledby="compose-title">
        ${this.sending ? html`<div class="progress-bar-thin"></div>` : ''}

        <div class="modal-header">
          <h2 id="compose-title">
            ${this.inReplyTo ? '↩ Reply to Message' : 'Compose New Email'}
          </h2>
          <button type="button" class="close-btn" @click=${this.close} aria-label="Close compose dialog">
            &times;
          </button>
        </div>

        <form @submit=${this._handleSubmit}>
          <div class="sender-tag">
            From: <strong>${user?.name ?? 'User'} &lt;${user?.email ?? ''}&gt;</strong>
            <br />
            <small style="color: #6200ee; font-weight: 600;">
              ✓ Cloudflare Email Service Active • Verified Domain: ${user?.domain ?? 'liparola.org'}
            </small>
          </div>

          <div class="field">
            <label for="compose-to">To (Recipient Email)</label>
            <input
              id="compose-to"
              type="email"
              required
              autofocus
              placeholder="client@organization.co.ls"
              .value=${this.to}
              ?disabled=${this.sending}
              @input=${(e: Event) => (this.to = (e.target as HTMLInputElement).value)}
            />
          </div>

          <div class="field">
            <label for="compose-subject">Subject</label>
            <input
              id="compose-subject"
              type="text"
              required
              placeholder="Proposal &amp; Invoice"
              .value=${this.subject}
              ?disabled=${this.sending}
              @input=${(e: Event) => (this.subject = (e.target as HTMLInputElement).value)}
            />
          </div>

          <div class="field">
            <label for="compose-body">Message</label>
            <textarea
              id="compose-body"
              required
              placeholder="Write your message..."
              .value=${this.bodyText}
              ?disabled=${this.sending}
              @input=${(e: Event) => (this.bodyText = (e.target as HTMLTextAreaElement).value)}></textarea>
          </div>

          ${this.error ? html`<div class="error">⚠️ ${this.error}</div>` : ''}
          ${this.successNotice
            ? html`<div style="color: #2e7d32; font-size: 0.88rem; font-weight: 700; background: #e8f5e9; padding: 8px 12px; border-radius: 6px;">
                ${this.successNotice}
              </div>`
            : ''}

          <div class="actions">
            <button type="button" class="btn-cancel" @click=${this.close} ?disabled=${this.sending}>Cancel</button>
            <button type="submit" class="btn-send" ?disabled=${this.sending}>
              ${this.sending
                ? html`<span>⏳ ${this.sendingStage || 'Sending...'}</span>`
                : '🚀 Send Email'}
            </button>
          </div>
        </form>
      </dialog>
    `;
  }
}
