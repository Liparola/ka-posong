import { LitElement, html, css } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { mailService, type EmailAttachment } from '../services/mail';
import { authService } from '../services/auth';
import {
  fileToAttachmentPayload,
  validateAttachmentFile,
  formatBytes,
  getAttachmentIcon,
  saveStagedDraftAttachments,
  getStagedDraftAttachments,
  clearStagedDraftAttachments,
  AttachmentRecoveryStack,
} from '../utils/attachment-cache';

/**
 * compose-modal — Native <dialog> modal for composing and sending emails via Stalwart / Cloudflare.
 * Supports up to 120MB attachments, resilient client-side staging, disaster recovery back-popping,
 * and persistent draft cache in IndexedDB.
 */
@customElement('compose-modal')
export class ComposeModal extends LitElement {
  @state() private to = '';
  @state() private subject = '';
  @state() private bodyText = '';
  @state() private inReplyTo = '';
  @state() private threadId = '';
  @state() private attachments: EmailAttachment[] = [];
  @state() private isReadingAttachment = false;
  @state() private readingProgress = '';
  @state() private isDragOver = false;
  @state() private sending = false;
  @state() private sendingStage = '';
  @state() private error = '';
  @state() private successNotice = '';

  private recoveryStack = new AttachmentRecoveryStack();

  @query('dialog') private dialogEl!: HTMLDialogElement;
  @query('#compose-file-input') private fileInputEl!: HTMLInputElement;

  static styles = css`
    dialog {
      border: none;
      border-radius: 14px;
      padding: 0;
      width: 92vw;
      max-width: 620px;
      max-height: 90vh;
      box-shadow: 0 20px 45px rgba(0, 0, 0, 0.25);
      background: #fff;
      color: #333;
      position: relative;
      overflow-y: auto;
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
      position: sticky;
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
      min-height: 140px;
      resize: vertical;
    }

    /* Attachment Staging Area & Drop Zone */
    .drop-zone {
      border: 2px dashed #d0d0e0;
      border-radius: 10px;
      padding: 12px;
      background: #fafafc;
      transition: all 0.2s ease;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .drop-zone.dragover {
      border-color: #6200ee;
      background: #f0eaff;
    }

    .drop-zone-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.82rem;
      color: #555;
    }

    .btn-attach {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 14px;
      border: 1px solid #6200ee;
      background: #f7f3ff;
      color: #6200ee;
      border-radius: 7px;
      font-size: 0.84rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .btn-attach:hover {
      background: #ede4ff;
    }

    .attachment-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 4px;
    }

    .attachment-chip {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 0.82rem;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
    }

    .attachment-chip .filename {
      max-width: 190px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
    }

    .attachment-chip .filesize {
      color: #777;
      font-size: 0.76rem;
    }

    .attachment-chip .btn-remove {
      background: transparent;
      border: none;
      color: #888;
      font-weight: bold;
      cursor: pointer;
      padding: 0 3px;
      font-size: 0.95rem;
      line-height: 1;
      border-radius: 4px;
    }

    .attachment-chip .btn-remove:hover {
      color: #d32f2f;
      background: #ffebee;
    }

    .recovery-banner {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 0.8rem;
      color: #2e7d32;
      background: #edf7ed;
      padding: 4px 10px;
      border-radius: 6px;
    }

    .btn-undo {
      background: transparent;
      border: none;
      color: #1b5e20;
      font-weight: 700;
      text-decoration: underline;
      cursor: pointer;
      padding: 0;
      font-size: 0.8rem;
    }

    .error {
      color: #d32f2f;
      font-size: 0.84rem;
      min-height: 18px;
    }

    .actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
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
      padding: 10px 24px;
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

  async open(
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
    this.recoveryStack.clear();

    // Check for cached draft attachments in IndexedDB
    const draftKey = this.threadId ? `draft_thread_${this.threadId}` : 'draft_compose_modal';
    const cachedAtts = await getStagedDraftAttachments(draftKey);
    if (cachedAtts && cachedAtts.length > 0) {
      this.attachments = cachedAtts;
    } else {
      this.attachments = [];
    }

    this.dialogEl?.showModal();
  }

  public close() {
    this.dialogEl?.close();
  }

  private _onDragOver(e: DragEvent) {
    e.preventDefault();
    this.isDragOver = true;
  }

  private _onDragLeave(e: DragEvent) {
    e.preventDefault();
    this.isDragOver = false;
  }

  private _onDrop(e: DragEvent) {
    e.preventDefault();
    this.isDragOver = false;
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      this._processCandidateFiles(Array.from(e.dataTransfer.files));
    }
  }

  private _handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this._processCandidateFiles(Array.from(input.files));
    }
    input.value = '';
  }

  private async _processCandidateFiles(files: File[]) {
    this.error = '';
    const currentTotalBytes = this.attachments.reduce((acc, a) => acc + (a.size_bytes || 0), 0);
    let runningTotal = currentTotalBytes;

    for (const file of files) {
      const val = validateAttachmentFile(file, runningTotal);
      if (!val.valid) {
        this.error = val.error || `File ${file.name} cannot be attached.`;
        return;
      }
      runningTotal += file.size;
    }

    this.isReadingAttachment = true;
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        this.readingProgress = `Staging ${file.name} (${i + 1}/${files.length})...`;
        const att = await fileToAttachmentPayload(file, (percent) => {
          this.readingProgress = `Encoding ${file.name}: ${percent}%`;
        });
        this.attachments = [...this.attachments, att];
      }

      // Persist staged attachments to IndexedDB temporary holding space
      const draftKey = this.threadId ? `draft_thread_${this.threadId}` : 'draft_compose_modal';
      await saveStagedDraftAttachments(draftKey, this.attachments);
    } catch (err: unknown) {
      this.error = err instanceof Error ? err.message : 'Error reading attachment file';
    } finally {
      this.isReadingAttachment = false;
      this.readingProgress = '';
    }
  }

  private async _removeAttachment(idx: number) {
    if (idx >= 0 && idx < this.attachments.length) {
      const removed = this.attachments[idx];
      this.recoveryStack.push(removed);
      this.attachments = this.attachments.filter((_, i) => i !== idx);

      const draftKey = this.threadId ? `draft_thread_${this.threadId}` : 'draft_compose_modal';
      await saveStagedDraftAttachments(draftKey, this.attachments);
    }
  }

  private async _undoRemoveAttachment() {
    const popped = this.recoveryStack.pop();
    if (popped) {
      this.attachments = [...this.attachments, popped];
      const draftKey = this.threadId ? `draft_thread_${this.threadId}` : 'draft_compose_modal';
      await saveStagedDraftAttachments(draftKey, this.attachments);
      this.requestUpdate();
    }
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
      this.sendingStage = this.attachments.length > 0
        ? `Transmitting MIME envelope with ${this.attachments.length} attachment(s)...`
        : 'Transmitting signed MIME envelope...';
    }, 450);

    try {
      const res = await mailService.sendMessage(
        this.to.trim(),
        this.subject.trim() || '(No Subject)',
        this.bodyText,
        undefined,
        this.inReplyTo || undefined,
        this.threadId || undefined,
        this.attachments
      );
      clearTimeout(stageTimer);

      const provider = res.delivery_provider ?? 'Cloudflare Email Service';
      const isExternal = res.relayed_externally === true;

      if (isExternal) {
        this.successNotice = `✓ Sent & delivered to ${this.to.trim()} via ${provider}`;
      } else {
        this.successNotice = `✓ Saved in Sent mailbox (${provider}). External delivery queued.`;
      }

      // Clear draft attachments cache from IndexedDB
      const draftKey = this.threadId ? `draft_thread_${this.threadId}` : 'draft_compose_modal';
      await clearStagedDraftAttachments(draftKey);
      this.attachments = [];
      this.recoveryStack.clear();

      window.dispatchEvent(
        new CustomEvent('email-sent', {
          detail: {
            to: this.to.trim(),
            provider,
            relayedExternally: isExternal,
            message: this.successNotice,
          },
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
    const totalBytes = this.attachments.reduce((acc, a) => acc + (a.size_bytes || 0), 0);

    return html`
      <dialog aria-labelledby="compose-title">
        ${this.sending || this.isReadingAttachment
          ? html`<div class="progress-bar-thin"></div>`
          : ''}

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

          <!-- Staged Attachments Drop Zone & Queue Area -->
          <div
            class="drop-zone ${this.isDragOver ? 'dragover' : ''}"
            @dragover=${this._onDragOver}
            @dragleave=${this._onDragLeave}
            @drop=${this._onDrop}>
            <div class="drop-zone-header">
              <button
                type="button"
                class="btn-attach"
                ?disabled=${this.sending || this.isReadingAttachment}
                @click=${() => this.fileInputEl.click()}>
                📎 Attach Files (Max 120MB)
              </button>
              <input
                id="compose-file-input"
                type="file"
                multiple
                style="display:none;"
                @change=${this._handleFileSelect}
              />

              <span>
                ${totalBytes > 0
                  ? html`<strong>${formatBytes(totalBytes)}</strong> / 120 MB max`
                  : html`Drag &amp; drop files or click attach`}
              </span>
            </div>

            ${this.isReadingAttachment
              ? html`<div style="font-size:0.82rem; color:#6200ee; font-weight:600;">
                  ⏳ ${this.readingProgress}
                </div>`
              : ''}

            ${this.attachments.length > 0
              ? html`
                  <div class="attachment-chips">
                    ${this.attachments.map(
                      (att, idx) => html`
                        <div class="attachment-chip">
                          <span>${getAttachmentIcon(att.filename, att.content_type)}</span>
                          <span class="filename" title="${att.filename}">${att.filename}</span>
                          <span class="filesize">(${formatBytes(att.size_bytes)})</span>
                          <button
                            type="button"
                            class="btn-remove"
                            title="Remove attachment"
                            @click=${() => this._removeAttachment(idx)}>
                            &times;
                          </button>
                        </div>
                      `
                    )}
                  </div>
                `
              : ''}

            ${this.recoveryStack.size() > 0
              ? html`
                  <div class="recovery-banner">
                    <span>File removed.</span>
                    <button type="button" class="btn-undo" @click=${this._undoRemoveAttachment}>
                      ↺ Undo remove (${this.recoveryStack.peek()?.filename})
                    </button>
                  </div>
                `
              : ''}
          </div>

          ${this.error ? html`<div class="error">⚠️ ${this.error}</div>` : ''}
          ${this.successNotice
            ? html`<div style="color: #2e7d32; font-size: 0.88rem; font-weight: 700; background: #e8f5e9; padding: 8px 12px; border-radius: 6px;">
                ${this.successNotice}
              </div>`
            : ''}

          <div class="actions">
            <button type="button" class="btn-cancel" @click=${this.close} ?disabled=${this.sending}>
              Cancel
            </button>
            <button type="submit" class="btn-send" ?disabled=${this.sending || this.isReadingAttachment}>
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
