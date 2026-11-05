import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { mailService } from '../services/mail';
import { authService } from '../services/auth';
import {
  normalizeMailMessage,
  safeSetEmailHTML,
  type NormalizedMailMessage,
} from '../utils/mime-renderer';

type RenderMode = 'rich' | 'plain' | 'meta';

@customElement('view-mailbox')
export class ViewMailbox extends LitElement {
  @property({ type: String }) folder = 'inbox';
  @state() private messages: NormalizedMailMessage[] = [];
  @state() private selectedMessage: NormalizedMailMessage | null = null;
  @state() private searchQuery = '';
  @state() private loading = true;
  @state() private renderMode: RenderMode = 'rich';

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
      padding: 8px 13px;
      border-radius: 8px;
      border: 1px solid #d0c4f7;
      background: #fff;
      color: #6200ee;
      font-weight: 600;
      font-size: 0.83rem;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .btn-action:hover {
      background: #f3ebff;
    }

    .btn-action.active {
      background: #6200ee;
      color: #fff;
      border-color: #6200ee;
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
      display: flex;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid #f0f0f5;
      cursor: pointer;
      transition: background 0.15s;
      border-left: 4px solid transparent;
      align-items: flex-start;
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

    .avatar-circle {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: linear-gradient(135deg, #6200ee, #9c27b0);
      color: #fff;
      font-weight: 700;
      font-size: 0.8rem;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-top: 2px;
    }

    .msg-content {
      flex: 1;
      min-width: 0;
    }

    .msg-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 3px;
      gap: 6px;
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
      font-size: 0.73rem;
      color: #777;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .subject {
      font-size: 0.87rem;
      font-weight: 600;
      color: #2b2b3c;
      margin-bottom: 3px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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

    .reader-subject-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 12px;
    }

    .reader-header h2 {
      margin: 0;
      font-size: 1.28rem;
      color: #1a1a2e;
      line-height: 1.35;
    }

    .sender-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      background: #faf8ff;
      border: 1px solid #ece3ff;
      border-radius: 10px;
      padding: 12px 14px;
    }

    .sender-card-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .sender-meta {
      font-size: 0.85rem;
      color: #444;
      line-height: 1.45;
    }

    .sender-meta strong {
      font-size: 0.94rem;
      color: #1a1a2e;
    }

    .email-pill {
      color: #6200ee;
      font-family: monospace;
      font-size: 0.81rem;
      background: #f0e6ff;
      padding: 1px 6px;
      border-radius: 4px;
    }

    .spf-badge {
      background: #e8f5e9;
      color: #2e7d32;
      font-weight: 700;
      font-size: 0.74rem;
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid #c8e6c9;
      white-space: nowrap;
    }

    .meta-drawer {
      margin-top: 10px;
      font-size: 0.81rem;
      color: #444;
      background: #fcfcfe;
      border: 1px solid #e6e4f0;
      border-radius: 8px;
      padding: 8px 12px;
    }

    .meta-drawer summary {
      cursor: pointer;
      font-weight: 600;
      color: #555;
      user-select: none;
    }

    .meta-grid {
      display: grid;
      grid-template-columns: 130px 1fr;
      gap: 6px 12px;
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px dashed #e0dce8;
    }

    .meta-label {
      font-weight: 600;
      color: #666;
    }

    .security-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .sec-pill {
      background: #eefaf0;
      color: #1b5e20;
      border: 1px solid #c8e6c9;
      border-radius: 4px;
      padding: 2px 7px;
      font-size: 0.73rem;
      font-weight: 600;
    }

    .reader-toolbar {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-top: 12px;
    }

    .reader-actions,
    .render-mode-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .reader-body-rich {
      line-height: 1.7;
      color: #242433;
      font-size: 0.96rem;
      flex: 1;
      word-break: break-word;
    }

    .reader-body-rich a {
      color: #6200ee;
      text-decoration: underline;
    }

    .reader-body-rich blockquote {
      margin: 10px 0;
      padding: 8px 14px;
      border-left: 3px solid #9c27b0;
      background: #faf7ff;
      color: #555;
      border-radius: 0 6px 6px 0;
    }

    .reader-body-rich hr {
      border: none;
      border-top: 1px solid #e5e0f0;
      margin: 16px 0;
    }

    .reader-body-rich pre,
    .reader-body-rich code {
      background: #f5f2fa;
      border-radius: 4px;
      padding: 2px 5px;
      font-family: monospace;
      font-size: 0.86rem;
    }

    .reader-body-plain {
      white-space: pre-wrap;
      line-height: 1.65;
      color: #2c2c38;
      font-size: 0.93rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background: #fafafe;
      padding: 16px;
      border-radius: 8px;
      border: 1px solid #ececf4;
      flex: 1;
    }

    .meta-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
      font-size: 0.82rem;
    }

    .meta-table th,
    .meta-table td {
      padding: 8px 10px;
      border: 1px solid #e6e4f0;
      text-align: left;
    }

    .meta-table th {
      background: #f4f0ff;
      color: #3700b3;
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
    this._syncSanitizedRichBody();
  }

  private _syncSanitizedRichBody() {
    if (!this.selectedMessage || this.renderMode !== 'rich') return;
    const container = this.renderRoot.querySelector('.reader-body-rich') as HTMLElement | null;
    if (container) {
      safeSetEmailHTML(container, this.selectedMessage.cleanHtml);
    }
  }

  async loadFolder() {
    this.loading = true;
    try {
      const rawMessages = await mailService.fetchMessages(this.folder, this.searchQuery);
      this.messages = rawMessages.map((m) => normalizeMailMessage(m));
      if (this.messages.length > 0) {
        const currentId = this.selectedMessage?.id;
        this.selectedMessage =
          this.messages.find((m) => m.id === currentId) ?? this.messages[0];
      } else {
        this.selectedMessage = null;
      }
    } catch {
      this.messages = [];
    } finally {
      this.loading = false;
    }
  }

  private async _selectMessage(msg: NormalizedMailMessage) {
    this.selectedMessage = msg;
    if (!msg.is_read) {
      msg.is_read = true;
      this.requestUpdate();
      await mailService.updateMessage(msg.id, { is_read: true });
    }
  }

  private async _toggleStar(msg: NormalizedMailMessage, e: Event) {
    e.stopPropagation();
    const next = !msg.is_starred;
    msg.is_starred = next;
    this.requestUpdate();
    await mailService.updateMessage(msg.id, { is_starred: next });
  }

  private async _moveFolder(msg: NormalizedMailMessage, targetFolder: string) {
    await mailService.updateMessage(msg.id, { folder: targetFolder });
    this.selectedMessage = null;
    await this.loadFolder();
  }

  private _reply(msg: NormalizedMailMessage) {
    this.dispatchEvent(
      new CustomEvent('open-compose', {
        detail: {
          to: msg.senderAddress,
          subject: msg.subject.startsWith('Re:') ? msg.subject : `Re: ${msg.subject}`,
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    const user = authService.getUser();
    const msg = this.selectedMessage;

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
                    class="msg-row ${!m.is_read ? 'unread' : ''} ${msg?.id === m.id ? 'active' : ''}"
                    @click=${() => this._selectMessage(m)}>
                    <div class="avatar-circle">${m.senderInitials}</div>
                    <div class="msg-content">
                      <div class="msg-top">
                        <span class="sender">
                          <span
                            @click=${(e: Event) => this._toggleStar(m, e)}
                            style="color:${m.is_starred ? '#f59e0b' : '#ccc'}; margin-right:5px;">
                            ★
                          </span>
                          ${this.folder === 'sent' ? `To: ${m.recipient_email}` : m.senderDisplayName}
                        </span>
                        <span class="date">${m.formattedDateShort}</span>
                      </div>
                      <div class="subject">${m.subject}</div>
                      <div class="preview">${m.cleanPreview}</div>
                    </div>
                  </div>
                `
              )}
        </div>

        <div class="reader-pane">
          ${msg
            ? html`
                <div class="reader-header">
                  <div class="reader-subject-row">
                    <h2>${msg.subject}</h2>
                    <span class="spf-badge">✓ ${msg.spf_dmarc_status}</span>
                  </div>

                  <div class="sender-card">
                    <div class="sender-card-left">
                      <div class="avatar-circle">${msg.senderInitials}</div>
                      <div class="sender-meta">
                        <div>
                          <strong>${msg.senderDisplayName}</strong>
                          <span class="email-pill">&lt;${msg.senderAddress}&gt;</span>
                        </div>
                        <div>
                          <strong>To:</strong>
                          <span class="email-pill">${msg.recipient_email}</span>
                          • <span>${msg.formattedDateFull}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <details class="meta-drawer">
                    <summary>🔐 Security, Authentication &amp; MIME Envelope Metadata</summary>
                    <div class="meta-grid">
                      <span class="meta-label">Message ID:</span>
                      <span><code>${msg.id}</code></span>
                      <span class="meta-label">Sender Domain:</span>
                      <span><code>${msg.senderDomain}</code></span>
                      <span class="meta-label">Authentication:</span>
                      <div class="security-pills">
                        ${msg.securityBadges.map(
                          (b) => html`<span class="sec-pill">✓ ${b.label}</span>`
                        )}
                      </div>
                      <span class="meta-label">MIME Structure:</span>
                      <span>
                        ${msg.mimeBoundary
                          ? html`Multipart (boundary: <code>${msg.mimeBoundary}</code>)`
                          : html`Standard RFC 5322 (${msg.mimeParts.length} part)`}
                      </span>
                    </div>
                  </details>

                  <div class="reader-toolbar">
                    <div class="reader-actions">
                      <button class="btn-action" @click=${() => this._reply(msg)}>
                        ↩ Reply
                      </button>
                      <button
                        class="btn-action"
                        @click=${() => this._moveFolder(msg, 'archive')}>
                        📥 Archive
                      </button>
                      <button class="btn-action" @click=${() => this._moveFolder(msg, 'trash')}>
                        🗑 Trash
                      </button>
                    </div>

                    <div class="render-mode-tabs">
                      <button
                        class="btn-action ${this.renderMode === 'rich' ? 'active' : ''}"
                        @click=${() => {
                          this.renderMode = 'rich';
                        }}>
                        ✨ Rich View
                      </button>
                      <button
                        class="btn-action ${this.renderMode === 'plain' ? 'active' : ''}"
                        @click=${() => {
                          this.renderMode = 'plain';
                        }}>
                        📄 Plain Text
                      </button>
                      <button
                        class="btn-action ${this.renderMode === 'meta' ? 'active' : ''}"
                        @click=${() => {
                          this.renderMode = 'meta';
                        }}>
                        🔍 MIME Inspector
                      </button>
                    </div>
                  </div>
                </div>

                ${this.renderMode === 'rich'
                  ? html`<div class="reader-body-rich"></div>`
                  : this.renderMode === 'plain'
                  ? html`<div class="reader-body-plain">${msg.cleanText}</div>`
                  : html`
                      <div class="reader-body-plain">
                        <strong>Parsed MIME Parts (${msg.mimeParts.length}):</strong>
                        <table class="meta-table">
                          <thead>
                            <tr>
                              <th>Part #</th>
                              <th>Content-Type</th>
                              <th>Charset</th>
                              <th>Transfer-Encoding</th>
                              <th>Decoded Size</th>
                            </tr>
                          </thead>
                          <tbody>
                            ${msg.mimeParts.map(
                              (p, idx) => html`
                                <tr>
                                  <td>#${idx + 1}</td>
                                  <td><code>${p.contentType}</code></td>
                                  <td><code>${p.charset}</code></td>
                                  <td><code>${p.transferEncoding}</code></td>
                                  <td>${p.sizeBytes} bytes</td>
                                </tr>
                              `
                            )}
                          </tbody>
                        </table>
                        <br />
                        <strong>Extracted Clean Plain-Text Stream:</strong>
                        <hr />
                        ${msg.cleanText}
                      </div>
                    `}
              `
            : html`<div class="empty-state">Select a message to read its full contents.</div>`}
        </div>
      </div>
    `;
  }
}
