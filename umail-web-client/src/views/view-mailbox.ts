import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { mailService, type MailMessage } from '../services/mail';
import { authService } from '../services/auth';

@customElement('view-mailbox')
export class ViewMailbox extends LitElement {
  @property({ type: String }) folder = 'inbox';
  @state() private messages: MailMessage[] = [];
  @state() private selectedMessage: MailMessage | null = null;
  @state() private searchQuery = '';
  @state() private loading = true;

  private _mailUpdateHandler!: () => void;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      box-sizing: border-box;
      overflow: hidden;
    }

    .org-banner {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      background: linear-gradient(135deg, #6200ee 0%, #9c27b0 100%);
      color: white;
      border-radius: 12px;
      padding: 14px 20px;
      margin-bottom: 14px;
      box-shadow: 0 4px 12px rgba(98, 0, 238, 0.18);
    }

    .org-banner h3 {
      margin: 0;
      font-size: 1.05rem;
      font-weight: 700;
    }

    .org-banner small {
      opacity: 0.9;
      font-size: 0.8rem;
      display: block;
    }

    .plan-badge {
      margin-left: auto;
      background: rgba(255, 255, 255, 0.22);
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }

    .search-box {
      flex: 1;
      display: flex;
      align-items: center;
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 10px;
      padding: 8px 14px;
    }

    .search-box input {
      border: none;
      outline: none;
      flex: 1;
      font-size: 0.92rem;
    }

    .btn-action {
      padding: 9px 14px;
      border-radius: 8px;
      border: 1px solid #d0c4f7;
      background: #fff;
      color: #6200ee;
      font-weight: 600;
      font-size: 0.85rem;
      cursor: pointer;
    }

    .btn-action:hover {
      background: #f3ebff;
    }

    .split-pane {
      flex: 1;
      display: grid;
      grid-template-columns: 1fr;
      gap: 14px;
      overflow: hidden;
    }

    @media (min-width: 900px) {
      .split-pane {
        grid-template-columns: 380px 1fr;
      }
    }

    .message-list {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
      overflow-y: auto;
      border: 1px solid #eee;
    }

    .msg-row {
      padding: 14px 16px;
      border-bottom: 1px solid #f0f0f5;
      cursor: pointer;
      transition: background 0.15s;
      border-left: 4px solid transparent;
    }

    .msg-row:hover {
      background: #faf9ff;
    }

    .msg-row.unread {
      border-left-color: #6200ee;
      background: #fdfcff;
    }

    .msg-row.active {
      background: #f2ebff;
      border-left-color: #3700b3;
    }

    .msg-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }

    .sender {
      font-size: 0.9rem;
      font-weight: 700;
      color: #1a1a2e;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .date {
      font-size: 0.74rem;
      color: #888;
      white-space: nowrap;
    }

    .subject {
      font-size: 0.88rem;
      font-weight: 600;
      color: #333;
      margin-bottom: 3px;
    }

    .preview {
      font-size: 0.8rem;
      color: #666;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .reader-pane {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
      padding: 24px;
      overflow-y: auto;
      border: 1px solid #eee;
      display: flex;
      flex-direction: column;
    }

    .reader-header {
      border-bottom: 1px solid #eee;
      padding-bottom: 16px;
      margin-bottom: 18px;
    }

    .reader-header h2 {
      margin: 0 0 10px 0;
      font-size: 1.25rem;
      color: #1a1a2e;
    }

    .meta-row {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      font-size: 0.84rem;
      color: #555;
    }

    .spf-badge {
      background: #e8f5e9;
      color: #2e7d32;
      font-weight: 700;
      font-size: 0.73rem;
      padding: 3px 8px;
      border-radius: 6px;
    }

    .reader-actions {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }

    .reader-body {
      white-space: pre-wrap;
      line-height: 1.65;
      color: #2c2c38;
      font-size: 0.95rem;
      flex: 1;
    }

    .empty-state {
      text-align: center;
      padding: 48px 20px;
      color: #888;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this._mailUpdateHandler = () => this.loadFolder();
    mailService.addEventListener('mail-updated', this._mailUpdateHandler);
    this.loadFolder();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    mailService.removeEventListener('mail-updated', this._mailUpdateHandler);
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('folder')) {
      this.selectedMessage = null;
      this.loadFolder();
    }
  }

  async loadFolder() {
    this.loading = true;
    try {
      this.messages = await mailService.fetchMessages(this.folder, this.searchQuery);
      if (this.messages.length > 0 && !this.selectedMessage) {
        this.selectedMessage = this.messages[0];
      }
    } catch {
      this.messages = [];
    } finally {
      this.loading = false;
    }
  }

  private async _selectMessage(msg: MailMessage) {
    this.selectedMessage = msg;
    if (!msg.is_read) {
      msg.is_read = true;
      this.requestUpdate();
      await mailService.updateMessage(msg.id, { is_read: true });
    }
  }

  private async _toggleStar(msg: MailMessage, e: Event) {
    e.stopPropagation();
    const next = !msg.is_starred;
    msg.is_starred = next;
    this.requestUpdate();
    await mailService.updateMessage(msg.id, { is_starred: next });
  }

  private async _moveFolder(msg: MailMessage, targetFolder: string) {
    await mailService.updateMessage(msg.id, { folder: targetFolder });
    this.selectedMessage = null;
    await this.loadFolder();
  }

  private _reply(msg: MailMessage) {
    this.dispatchEvent(
      new CustomEvent('open-compose', {
        detail: {
          to: msg.sender_email,
          subject: msg.subject.startsWith('Re:') ? msg.subject : `Re: ${msg.subject}`
        },
        bubbles: true,
        composed: true
      })
    );
  }

  render() {
    const user = authService.getUser();

    return html`
      <div class="org-banner">
        <div>
          <h3>${user?.email ?? 'uMail Inbox'}</h3>
          <small>
            UMANG Phone ID: ${user?.phone ?? ''} • Domain: ${user?.domain ?? 'liparola.org'} •
            Stalwart JMAP/SMTP Connected
          </small>
        </div>
        <span class="plan-badge">${user?.subscription ?? 'ENTERPRISE'} TIER</span>
      </div>

      <div class="toolbar">
        <div class="search-box">
          <input
            type="search"
            placeholder="Search messages in ${this.folder}..."
            .value=${this.searchQuery}
            @input=${(e: Event) => {
              this.searchQuery = (e.target as HTMLInputElement).value;
              this.loadFolder();
            }}
          />
        </div>
        <button class="btn-action" @click=${() => this.loadFolder()}>↻ Refresh</button>
      </div>

      <div class="split-pane">
        <div class="message-list">
          ${this.loading
            ? html`<div class="empty-state">Syncing ${this.folder} with Stalwart...</div>`
            : this.messages.length === 0
            ? html`<div class="empty-state">No messages in <strong>${this.folder}</strong>.</div>`
            : this.messages.map(
                (m) => html`
                  <div
                    class="msg-row ${!m.is_read ? 'unread' : ''} ${this.selectedMessage?.id === m.id
                      ? 'active'
                      : ''}"
                    @click=${() => this._selectMessage(m)}>
                    <div class="msg-top">
                      <span class="sender">
                        <span
                          @click=${(e: Event) => this._toggleStar(m, e)}
                          style="color:${m.is_starred ? '#f59e0b' : '#ccc'}; margin-right:6px;">
                          ★
                        </span>
                        ${this.folder === 'sent' ? `To: ${m.recipient_email}` : m.sender_name}
                      </span>
                      <span class="date">${m.received_at.slice(0, 16)}</span>
                    </div>
                    <div class="subject">${m.subject}</div>
                    <div class="preview">${m.preview}</div>
                  </div>
                `
              )}
        </div>

        <div class="reader-pane">
          ${this.selectedMessage
            ? html`
                <div class="reader-header">
                  <h2>${this.selectedMessage.subject}</h2>
                  <div class="meta-row">
                    <div>
                      <strong>From:</strong> ${this.selectedMessage.sender_name}
                      &lt;${this.selectedMessage.sender_email}&gt;<br />
                      <strong>To:</strong> ${this.selectedMessage.recipient_email}
                    </div>
                    <span class="spf-badge">✓ ${this.selectedMessage.spf_dmarc_status}</span>
                  </div>
                  <div class="reader-actions">
                    <button
                      class="btn-action"
                      @click=${() => this._reply(this.selectedMessage!)}>
                      ↩ Reply
                    </button>
                    <button
                      class="btn-action"
                      @click=${() => this._moveFolder(this.selectedMessage!, 'archive')}>
                      📥 Archive
                    </button>
                    <button
                      class="btn-action"
                      @click=${() => this._moveFolder(this.selectedMessage!, 'trash')}>
                      🗑 Trash
                    </button>
                  </div>
                </div>
                <div class="reader-body">${this.selectedMessage.body_text}</div>
              `
            : html`<div class="empty-state">Select a message to read its full contents.</div>`}
        </div>
      </div>
    `;
  }
}
