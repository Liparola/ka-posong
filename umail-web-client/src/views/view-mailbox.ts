import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { mailService, type MailMessage } from '../services/mail';
import { authService } from '../services/auth';
import {
  normalizeMailMessage,
  safeSetEmailHTML,
  groupMessagesIntoThreads,
  type NormalizedMailMessage,
  type EmailThread,
} from '../utils/mime-renderer';

type RenderMode = 'rich' | 'plain' | 'meta';

@customElement('view-mailbox')
export class ViewMailbox extends LitElement {
  @property({ type: String }) folder = 'inbox';
  @state() private rawMessages: NormalizedMailMessage[] = [];
  @state() private threads: EmailThread[] = [];
  @state() private selectedThread: EmailThread | null = null;
  @state() private expandedMessageIds: Set<string> = new Set();
  @state() private searchQuery = '';
  @state() private loading = true;
  @state() private renderMode: RenderMode = 'rich';

  // Inline Quick Reply State
  @state() private inlineReplyText = '';
  @state() private inlineReplySending = false;
  @state() private inlineReplyNotice = '';
  @state() private inlineReplyError = '';

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
      display: inline-flex;
      align-items: center;
      gap: 4px;
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
      font-weight: 600;
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
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .thread-pill {
      background: #eee8fc;
      color: #6200ee;
      font-size: 0.72rem;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 12px;
      flex-shrink: 0;
    }

    .replied-tag {
      background: #e8f5e9;
      color: #2e7d32;
      font-size: 0.68rem;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 4px;
      flex-shrink: 0;
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
      gap: 16px;
    }

    .thread-header {
      border-bottom: 1px solid #eee;
      padding-bottom: 14px;
    }

    .thread-title-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 8px;
    }

    .thread-title-row h2 {
      margin: 0;
      font-size: 1.32rem;
      color: #1a1a2e;
      line-height: 1.35;
    }

    .thread-meta-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }

    .thread-tag {
      background: #f0e6ff;
      color: #6200ee;
      font-size: 0.75rem;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 6px;
    }

    .spf-badge {
      background: #e8f5e9;
      color: #2e7d32;
      font-weight: 700;
      font-size: 0.74rem;
      padding: 3px 8px;
      border-radius: 6px;
      border: 1px solid #c8e6c9;
      white-space: nowrap;
    }

    /* Conversation Stream & Message Cards */
    .conversation-stream {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .msg-card {
      border: 1px solid #ececf4;
      border-radius: 10px;
      background: #fff;
      overflow: hidden;
      transition: all 0.15s ease;
    }

    .msg-card-collapsed {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      background: #fbfbfe;
      cursor: pointer;
    }

    .msg-card-collapsed:hover {
      background: #f4f0ff;
    }

    .msg-card-collapsed .sender-name {
      font-size: 0.88rem;
      font-weight: 700;
      color: #2c2c3e;
      width: 160px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .msg-card-collapsed .collapsed-snippet {
      flex: 1;
      font-size: 0.82rem;
      color: #666;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .msg-card-collapsed .collapsed-date {
      font-size: 0.75rem;
      color: #888;
      white-space: nowrap;
    }

    .msg-card-expanded {
      padding: 18px 20px;
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
      margin-bottom: 12px;
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
      margin: 12px 0;
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

    /* Inline Quick Reply Drawer (Gmail / Outlook Standard UX) */
    .inline-reply-box {
      margin-top: 18px;
      background: #faf9fe;
      border: 1.5px solid #dcd5f2;
      border-radius: 12px;
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .reply-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.88rem;
      font-weight: 600;
      color: #444;
    }

    .reply-header strong {
      color: #6200ee;
    }

    .inline-reply-box textarea {
      width: 100%;
      min-height: 90px;
      padding: 12px;
      border: 1px solid #d0c8ea;
      border-radius: 8px;
      font-family: inherit;
      font-size: 0.94rem;
      line-height: 1.5;
      outline: none;
      box-sizing: border-box;
      resize: vertical;
      background: #fff;
    }

    .inline-reply-box textarea:focus {
      border-color: #6200ee;
      box-shadow: 0 0 0 2px rgba(98, 0, 238, 0.12);
    }

    .reply-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
    }

    .btn-send-reply {
      padding: 9px 20px;
      border: none;
      background: #6200ee;
      color: #fff;
      font-weight: 700;
      font-size: 0.88rem;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.15s;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .btn-send-reply:hover {
      background: #4b00b5;
    }

    .btn-send-reply:disabled {
      background: #bbb;
      cursor: not-allowed;
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
      this.selectedThread = null;
      this.loadFolder();
    }
    this._syncAllRichBodies();
  }

  private _syncAllRichBodies() {
    if (!this.selectedThread || this.renderMode !== 'rich') return;
    const containers = this.renderRoot.querySelectorAll('.reader-body-rich[data-msg-id]');
    containers.forEach((container) => {
      const id = container.getAttribute('data-msg-id');
      const m = this.selectedThread?.messages.find((x) => x.id === id);
      if (m && container instanceof HTMLElement) {
        safeSetEmailHTML(container, m.cleanHtml);
      }
    });
  }

  async loadFolder() {
    this.loading = true;
    try {
      const user = authService.getUser();
      const rawCurrent = await mailService.fetchMessages(this.folder, this.searchQuery);
      let allRaw: MailMessage[] = [...rawCurrent];

      // To assemble comprehensive conversation threads (like Gmail / Outlook),
      // also fetch sent messages if in inbox, or inbox if in sent
      if (!this.searchQuery) {
        if (this.folder === 'inbox') {
          const sent = await mailService.fetchMessages('sent').catch(() => []);
          allRaw.push(...sent);
        } else if (this.folder === 'sent') {
          const inbox = await mailService.fetchMessages('inbox').catch(() => []);
          allRaw.push(...inbox);
        }
      }

      // Deduplicate by message ID
      const seenIds = new Set<string>();
      const deduped: MailMessage[] = [];
      for (const m of allRaw) {
        if (!seenIds.has(m.id)) {
          seenIds.add(m.id);
          deduped.push(m);
        }
      }

      this.rawMessages = deduped.map((m) => normalizeMailMessage(m));
      this.threads = groupMessagesIntoThreads(this.rawMessages, user?.email ?? '');

      if (this.threads.length > 0) {
        const currentThreadKey = this.selectedThread?.threadKey;
        this.selectedThread =
          this.threads.find((t) => t.threadKey === currentThreadKey) ?? this.threads[0];
        // Expand the latest message by default
        this.expandedMessageIds = new Set([this.selectedThread.latestMessage.id]);
      } else {
        this.selectedThread = null;
        this.expandedMessageIds = new Set();
      }
    } catch {
      this.threads = [];
      this.selectedThread = null;
    } finally {
      this.loading = false;
    }
  }

  private async _selectThread(thread: EmailThread) {
    this.selectedThread = thread;
    this.inlineReplyText = '';
    this.inlineReplyNotice = '';
    this.inlineReplyError = '';
    this.expandedMessageIds = new Set([thread.latestMessage.id]);

    // Mark unread messages in this thread as read
    for (const m of thread.messages) {
      if (!m.is_read) {
        m.is_read = true;
        await mailService.updateMessage(m.id, { is_read: true });
      }
    }
    thread.unreadCount = 0;
    this.requestUpdate();
  }

  private _toggleMessageExpansion(msgId: string) {
    if (this.expandedMessageIds.has(msgId)) {
      this.expandedMessageIds.delete(msgId);
    } else {
      this.expandedMessageIds.add(msgId);
    }
    this.requestUpdate();
  }

  private async _toggleStar(thread: EmailThread, e: Event) {
    e.stopPropagation();
    const next = !thread.isStarred;
    thread.isStarred = next;
    for (const m of thread.messages) {
      m.is_starred = next;
      await mailService.updateMessage(m.id, { is_starred: next });
    }
    this.requestUpdate();
  }

  private async _moveThreadFolder(thread: EmailThread, targetFolder: string) {
    for (const m of thread.messages) {
      await mailService.updateMessage(m.id, { folder: targetFolder });
    }
    this.selectedThread = null;
    await this.loadFolder();
  }

  private _openFullComposeForReply(thread: EmailThread) {
    const user = authService.getUser();
    const latest = thread.latestMessage;
    const isLatestFromSelf = user && latest.senderAddress.toLowerCase() === user.email.toLowerCase();
    const to = isLatestFromSelf ? latest.recipient_email : latest.senderAddress;
    const cleanSubj = thread.cleanSubject;
    const subject = cleanSubj.toLowerCase().startsWith('re:') ? cleanSubj : `Re: ${cleanSubj}`;

    this.dispatchEvent(
      new CustomEvent('open-compose', {
        detail: {
          to,
          subject,
          body: this.inlineReplyText,
          inReplyTo: latest.id,
          threadId: thread.threadKey.replace(/^tid_/, '').replace(/^subj_/, ''),
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  private async _sendInlineReply() {
    if (!this.selectedThread) return;
    const text = this.inlineReplyText.trim();
    if (!text) {
      this.inlineReplyError = 'Please write a message before sending.';
      return;
    }

    const user = authService.getUser();
    const latest = this.selectedThread.latestMessage;
    const isLatestFromSelf = user && latest.senderAddress.toLowerCase() === user.email.toLowerCase();
    const to = isLatestFromSelf ? latest.recipient_email : latest.senderAddress;
    const cleanSubj = this.selectedThread.cleanSubject;
    const subject = cleanSubj.toLowerCase().startsWith('re:') ? cleanSubj : `Re: ${cleanSubj}`;

    this.inlineReplySending = true;
    this.inlineReplyError = '';
    this.inlineReplyNotice = '';

    try {
      const res = await mailService.sendMessage(
        to,
        subject,
        text,
        undefined,
        latest.id,
        this.selectedThread.threadKey.replace(/^tid_/, '').replace(/^subj_/, '')
      );
      this.inlineReplyText = '';
      this.inlineReplyNotice = `Dispatched via ${res.delivery_provider ?? 'Cloudflare Email Service'}`;
      await this.loadFolder();
    } catch (err: unknown) {
      this.inlineReplyError = err instanceof Error ? err.message : 'Failed to send reply';
    } finally {
      this.inlineReplySending = false;
    }
  }

  private _quoteOriginalText() {
    if (!this.selectedThread) return;
    const latest = this.selectedThread.latestMessage;
    const quoted = latest.cleanText
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n');
    const header = `\n\nOn ${latest.formattedDateFull}, ${latest.senderDisplayName} wrote:\n`;
    this.inlineReplyText = (this.inlineReplyText + header + quoted).trim();
    this.requestUpdate();
  }

  render() {
    const user = authService.getUser();
    const thread = this.selectedThread;

    return html`
      <div class="org-banner">
        <div>
          <h3>${user?.email ?? 'uMail Inbox'}</h3>
          <small>
            UMANG Phone ID: ${user?.phone ?? ''} • Domain: ${user?.domain ?? 'liparola.org'} •
            Cloudflare Email Routing &amp; Sending (Beta)
          </small>
        </div>
        <span class="plan-badge">${user?.subscription ?? 'ENTERPRISE'} TIER</span>
      </div>

      <div class="toolbar">
        <div class="search-box">
          <input
            type="search"
            placeholder="Search conversations in ${this.folder}..."
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
        <!-- Thread Conversation List Pane -->
        <div class="message-list">
          ${this.loading
            ? html`<div class="empty-state">Syncing conversations with Cloudflare &amp; Stalwart...</div>`
            : this.threads.length === 0
            ? html`<div class="empty-state">No conversations in <strong>${this.folder}</strong>.</div>`
            : this.threads.map((t) => {
                const latest = t.latestMessage;
                const isSelected = thread?.threadKey === t.threadKey;
                return html`
                  <div
                    class="msg-row ${t.unreadCount > 0 ? 'unread' : ''} ${isSelected ? 'active' : ''}"
                    @click=${() => this._selectThread(t)}>
                    <div class="avatar-circle">${latest.senderInitials}</div>
                    <div class="msg-content">
                      <div class="msg-top">
                        <span class="sender">
                          <span
                            @click=${(e: Event) => this._toggleStar(t, e)}
                            style="color:${t.isStarred ? '#f59e0b' : '#ccc'}; cursor: pointer;">
                            ★
                          </span>
                          ${t.participantsSummary}
                          ${t.hasReplies
                            ? html`<span class="thread-pill">🧵 ${t.messages.length}</span>`
                            : ''}
                          ${t.participants.some((p) => p.isSelf)
                            ? html`<span class="replied-tag">↩ Replied</span>`
                            : ''}
                        </span>
                        <span class="date">${t.lastDateShort}</span>
                      </div>
                      <div class="subject">${t.cleanSubject}</div>
                      <div class="preview">${latest.cleanPreview}</div>
                    </div>
                  </div>
                `;
              })}
        </div>

        <!-- Conversation Reader Pane -->
        <div class="reader-pane">
          ${thread
            ? html`
                <div class="thread-header">
                  <div class="thread-title-row">
                    <h2>${thread.cleanSubject}</h2>
                    <span class="spf-badge">✓ ${thread.latestMessage.spf_dmarc_status}</span>
                  </div>
                  <div class="thread-meta-bar">
                    <span class="thread-tag">🧵 ${thread.messages.length} messages in conversation</span>
                    <span class="thread-tag">Cloudflare Verified Domain</span>
                    <button class="btn-action" style="padding: 2px 8px; font-size: 0.75rem;" @click=${() => this._moveThreadFolder(thread, 'archive')}>
                      📥 Archive
                    </button>
                    <button class="btn-action" style="padding: 2px 8px; font-size: 0.75rem;" @click=${() => this._moveThreadFolder(thread, 'trash')}>
                      🗑 Trash
                    </button>
                  </div>
                </div>

                <!-- Conversation Stream (All messages in thread) -->
                <div class="conversation-stream">
                  ${thread.messages.map((m, idx) => {
                    const isExpanded = this.expandedMessageIds.has(m.id);
                    const isLatest = idx === thread.messages.length - 1;

                    if (!isExpanded) {
                      // Collapsed Card
                      return html`
                        <div class="msg-card msg-card-collapsed" @click=${() => this._toggleMessageExpansion(m.id)}>
                          <div class="avatar-circle" style="width: 28px; height: 28px; font-size: 0.7rem;">${m.senderInitials}</div>
                          <span class="sender-name">${m.senderDisplayName}</span>
                          <span class="collapsed-snippet">${m.cleanPreview}</span>
                          <span class="collapsed-date">${m.formattedDateShort}</span>
                          <span style="color: #888; font-size: 0.8rem;">▼</span>
                        </div>
                      `;
                    }

                    // Expanded Card
                    return html`
                      <div class="msg-card msg-card-expanded">
                        <div class="sender-card">
                          <div class="sender-card-left">
                            <div class="avatar-circle">${m.senderInitials}</div>
                            <div class="sender-meta">
                              <div>
                                <strong>${m.senderDisplayName}</strong>
                                <span class="email-pill">&lt;${m.senderAddress}&gt;</span>
                              </div>
                              <div>
                                <strong>To:</strong>
                                <span class="email-pill">${m.recipient_email}</span>
                                • <span>${m.formattedDateFull}</span>
                              </div>
                            </div>
                          </div>
                          ${!isLatest
                            ? html`
                                <button class="btn-action" style="padding: 4px 8px; font-size: 0.75rem;" @click=${() => this._toggleMessageExpansion(m.id)}>
                                  ▲ Collapse
                                </button>
                              `
                            : ''}
                        </div>

                        <details class="meta-drawer">
                          <summary>🔐 Security, Authentication &amp; MIME Envelope Metadata</summary>
                          <div class="meta-grid">
                            <span class="meta-label">Message ID:</span>
                            <span><code>${m.id}</code></span>
                            <span class="meta-label">Sender Domain:</span>
                            <span><code>${m.senderDomain}</code></span>
                            <span class="meta-label">Authentication:</span>
                            <div class="security-pills">
                              ${m.securityBadges.map(
                                (b) => html`<span class="sec-pill">✓ ${b.label}</span>`
                              )}
                            </div>
                            <span class="meta-label">MIME Structure:</span>
                            <span>
                              ${m.mimeBoundary
                                ? html`Multipart (boundary: <code>${m.mimeBoundary}</code>)`
                                : html`Standard RFC 5322 (${m.mimeParts.length} part)`}
                            </span>
                          </div>
                        </details>

                        <div class="reader-toolbar">
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

                        ${this.renderMode === 'rich'
                          ? html`<div class="reader-body-rich" data-msg-id="${m.id}"></div>`
                          : this.renderMode === 'plain'
                          ? html`<div class="reader-body-plain">${m.cleanText}</div>`
                          : html`
                              <div class="reader-body-plain">
                                <strong>Parsed MIME Parts (${m.mimeParts.length}):</strong>
                                <br />
                                ${m.mimeParts.map(
                                  (p, partIdx) => html`
                                    <div>#${partIdx + 1}: ${p.contentType} (${p.sizeBytes} bytes, ${p.transferEncoding})</div>
                                  `
                                )}
                                <hr />
                                ${m.cleanText}
                              </div>
                            `}
                      </div>
                    `;
                  })}
                </div>

                <!-- Inline Quick Reply Box (Gmail & Outlook UX) -->
                <div class="inline-reply-box">
                  <div class="reply-header">
                    <span>
                      ↩ Reply to
                      <strong>
                        ${user && thread.latestMessage.senderAddress.toLowerCase() === user.email.toLowerCase()
                          ? thread.latestMessage.recipient_email
                          : thread.latestMessage.senderAddress}
                      </strong>
                    </span>
                    <button
                      class="btn-action"
                      style="padding: 3px 8px; font-size: 0.78rem;"
                      @click=${() => this._openFullComposeForReply(thread)}>
                      ⤢ Open in Full Composer
                    </button>
                  </div>

                  <textarea
                    placeholder="Write a reply... (Enter your response here)"
                    .value=${this.inlineReplyText}
                    @input=${(e: Event) => {
                      this.inlineReplyText = (e.target as HTMLTextAreaElement).value;
                    }}></textarea>

                  ${this.inlineReplyError
                    ? html`<div style="color: #d32f2f; font-size: 0.82rem; font-weight: 600;">⚠️ ${this.inlineReplyError}</div>`
                    : ''}
                  ${this.inlineReplyNotice
                    ? html`<div style="color: #2e7d32; font-size: 0.84rem; font-weight: 700;">✓ ${this.inlineReplyNotice}</div>`
                    : ''}

                  <div class="reply-actions">
                    <button
                      class="btn-action"
                      style="padding: 6px 12px; font-size: 0.8rem;"
                      @click=${() => this._quoteOriginalText()}>
                      📄 Quote text
                    </button>
                    <button
                      class="btn-send-reply"
                      ?disabled=${this.inlineReplySending}
                      @click=${() => this._sendInlineReply()}>
                      ${this.inlineReplySending ? '🚀 Sending via Cloudflare...' : '🚀 Send Reply'}
                    </button>
                  </div>
                </div>
              `
            : html`<div class="empty-state">Select a conversation thread to read messages.</div>`}
        </div>
      </div>
    `;
  }
}
