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
 * Converts formatted text into clean, standards-compliant email HTML
 * supporting bold, italic, underline, quotes, lists, code blocks, and paragraphs.
 */
function markdownToHtml(text: string): string {
  if (!text) return '';
  let clean = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Fenced code blocks
  clean = clean.replace(
    /```([\s\S]*?)```/g,
    '<pre style="background:#f4f4f7;border:1px solid #e2e2ea;padding:12px;border-radius:6px;font-family:Consolas,Monaco,monospace;font-size:13px;overflow-x:auto;"><code>$1</code></pre>'
  );

  // Inline code
  clean = clean.replace(
    /`([^`]+)`/g,
    '<code style="background:#f0f0f4;padding:2px 6px;border-radius:4px;font-family:Consolas,Monaco,monospace;font-size:13px;color:#d32f2f;">$1</code>'
  );

  // Bold
  clean = clean.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  clean = clean.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Underline
  clean = clean.replace(/_([^_]+)_/g, '<u>$1</u>');

  // Blockquotes
  clean = clean.replace(
    /^&gt;\s?(.*)$/gm,
    '<blockquote style="border-left:3.5px solid #6200ee;margin:8px 0;padding-left:14px;color:#555;font-style:italic;">$1</blockquote>'
  );

  // Bullet lists
  clean = clean.replace(/^(?:-|\*)\s+(.*)$/gm, '<li>$1</li>');
  clean = clean.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul style="margin:8px 0;padding-left:22px;">$1</ul>');
  clean = clean.replace(/<\/ul>\s*<ul[^>]*>/g, '');

  // Numbered lists
  clean = clean.replace(/^\d+\.\s+(.*)$/gm, '<li>$1</li>');

  // Paragraphs
  const paragraphs = clean.split(/\n{2,}/);
  const formattedHtml = paragraphs
    .map((p) => {
      const trimmed = p.trim();
      if (!trimmed) return '';
      if (
        trimmed.startsWith('<pre') ||
        trimmed.startsWith('<blockquote') ||
        trimmed.startsWith('<ul') ||
        trimmed.startsWith('<ol')
      ) {
        return trimmed;
      }
      return `<p style="margin:0 0 12px 0;line-height:1.65;">${trimmed.replace(/\n/g, '<br/>')}</p>`;
    })
    .join('');

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14.5px;color:#222;line-height:1.65;">${formattedHtml}</div>`;
}

interface PendingSendPayload {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  attachments: EmailAttachment[];
  inReplyTo?: string;
  threadId?: string;
}

/**
 * compose-modal — Native <dialog> modal for composing and sending emails via Stalwart / Cloudflare.
 * Supports:
 *  - Multi-recipient To, Cc & Bcc inputs (comma/semicolon-separated)
 *  - Top Feature 1: Background Auto-Save Drafts with live indicator
 *  - Top Feature 2: "Undo Send" 7-second grace period countdown floating snackbar
 *  - Top Feature 3: Rich text formatting toolbar & pro keyboard shortcuts (Ctrl+Enter, Ctrl+B, etc.)
 *  - Resilient attachments up to 120MB with IndexedDB staging and recovery back-popping
 */
@customElement('compose-modal')
export class ComposeModal extends LitElement {
  @state() private to = '';
  @state() private cc = '';
  @state() private bcc = '';
  @state() private showCc = false;
  @state() private showBcc = false;
  @state() private subject = '';
  @state() private bodyText = '';
  @state() private inReplyTo = '';
  @state() private threadId = '';
  @state() private attachments: EmailAttachment[] = [];
  @state() private isReadingAttachment = false;
  @state() private readingProgress = '';
  @state() private isDragOver = false;
  @state() private sending = false;
  @state() private error = '';

  // Feature 1: Auto-Save Draft State
  @state() private draftStatus: 'idle' | 'saving' | 'saved' = 'idle';
  @state() private draftSavedAt = '';
  @state() private draftBannerNotice = '';
  private _autoSaveTimer?: number;

  // Feature 2: Undo Send Grace Period State
  @state() private undoActive = false;
  @state() private undoSecondsRemaining = 7;
  @state() private undoTotalSeconds = 7;
  @state() private undoStatusText = '';
  @state() private undoState: 'countdown' | 'transmitting' | 'sent' | 'error' = 'countdown';
  private _undoIntervalTimer?: number;
  private _pendingSendPayload?: PendingSendPayload;

  private recoveryStack = new AttachmentRecoveryStack();
  private _onKeyDown!: (e: KeyboardEvent) => void;

  @query('dialog') private dialogEl!: HTMLDialogElement;
  @query('#compose-file-input') private fileInputEl!: HTMLInputElement;

  static styles = css`
    dialog {
      border: none;
      border-radius: 14px;
      padding: 0;
      width: 94vw;
      max-width: 660px;
      max-height: 92vh;
      max-height: 92dvh;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.32);
      background: #fff;
      color: #333;
      position: relative;
      overflow-y: auto;
    }

    @media (max-width: 640px) {
      dialog {
        width: 100vw;
        width: 100dvw;
        max-width: 100dvw;
        height: 100vh;
        height: 100dvh;
        max-height: 100dvh;
        margin: 0;
        border-radius: 0;
      }
      .shortcut-tip {
        display: none;
      }
    }

    dialog:modal {
      overscroll-behavior: contain;
    }

    dialog::backdrop {
      background: rgba(18, 12, 34, 0.58);
      backdrop-filter: blur(2px);
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
      z-index: 25;
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
      padding: 14px 20px;
      background: linear-gradient(135deg, #6200ee 0%, #3700b3 100%);
      color: #fff;
    }

    .modal-header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .modal-header h2 {
      margin: 0;
      font-size: 1.05rem;
      font-weight: 600;
    }

    .draft-header-badge {
      font-size: 0.72rem;
      background: rgba(255, 255, 255, 0.18);
      padding: 2px 8px;
      border-radius: 12px;
      font-weight: 500;
      letter-spacing: 0.02em;
    }

    .close-btn {
      background: transparent;
      border: none;
      color: #fff;
      font-size: 1.4rem;
      cursor: pointer;
      line-height: 1;
      padding: 4px 8px;
      border-radius: 6px;
    }

    .close-btn:hover {
      background: rgba(255, 255, 255, 0.18);
    }

    .draft-restore-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: #e8f5e9;
      color: #1b5e20;
      padding: 8px 18px;
      font-size: 0.82rem;
      border-bottom: 1px solid #c8e6c9;
    }

    .draft-restore-banner button {
      background: transparent;
      border: none;
      color: #b71c1c;
      font-weight: 600;
      cursor: pointer;
      font-size: 0.82rem;
      text-decoration: underline;
    }

    form {
      padding: 18px 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .sender-tag {
      font-size: 0.82rem;
      color: #555;
      background: #f7f6fc;
      padding: 8px 12px;
      border-radius: 8px;
      border-left: 3px solid #6200ee;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .field-label-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    label {
      font-size: 0.82rem;
      font-weight: 600;
      color: #555;
    }

    .recipient-toggle-links {
      display: flex;
      gap: 8px;
    }

    .btn-toggle-field {
      background: transparent;
      border: none;
      color: #6200ee;
      font-weight: 600;
      font-size: 0.78rem;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 4px;
    }

    .btn-toggle-field:hover {
      background: #f0ebff;
      text-decoration: underline;
    }

    .btn-remove-field {
      background: transparent;
      border: none;
      color: #888;
      font-weight: bold;
      font-size: 1.1rem;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }

    .btn-remove-field:hover {
      color: #d32f2f;
    }

    input,
    textarea {
      padding: 9px 12px;
      border: 1px solid #d4d4dc;
      border-radius: 8px;
      font-size: 0.94rem;
      font-family: inherit;
      outline: none;
      transition: border-color 0.15s, background 0.15s;
    }

    input:focus,
    textarea:focus {
      border-color: #6200ee;
      background: #fafaff;
    }

    /* Feature 3: Rich Text Formatting Toolbar */
    .formatting-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: #f6f6fa;
      border: 1px solid #e2e2ec;
      border-bottom: none;
      border-radius: 8px 8px 0 0;
      padding: 5px 8px;
    }

    .fmt-buttons {
      display: flex;
      align-items: center;
      gap: 3px;
    }

    .btn-fmt {
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 4px 7px;
      font-size: 0.86rem;
      color: #444;
      cursor: pointer;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 26px;
      height: 26px;
    }

    .btn-fmt:hover {
      background: #e8e8f2;
      border-color: #d0d0e0;
      color: #111;
    }

    .fmt-divider {
      display: inline-block;
      width: 1px;
      height: 18px;
      background: #dcdcda;
      margin: 0 4px;
    }

    .draft-status-pill {
      font-size: 0.76rem;
      color: #666;
    }

    .draft-status-pill .saved {
      color: #2e7d32;
      font-weight: 500;
    }

    .draft-status-pill .saving {
      color: #6200ee;
      font-style: italic;
    }

    textarea#compose-body {
      min-height: 140px;
      resize: vertical;
      border-radius: 0 0 8px 8px;
      border-top: none;
    }

    /* Attachment Staging Area & Drop Zone */
    .drop-zone {
      border: 2px dashed #d0d0e0;
      border-radius: 10px;
      padding: 10px 14px;
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
      padding: 6px 13px;
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
      margin-top: 2px;
    }

    .attachment-chip {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 8px;
      padding: 5px 10px;
      font-size: 0.82rem;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
    }

    .attachment-chip .filename {
      max-width: 200px;
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
      flex-wrap: wrap;
    }

    .actions-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .actions-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .btn-discard {
      padding: 8px 12px;
      border: 1px solid #e0e0e0;
      background: #fff;
      color: #777;
      border-radius: 8px;
      font-size: 0.82rem;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .btn-discard:hover {
      background: #ffebee;
      color: #c62828;
      border-color: #ffcdd2;
    }

    .shortcut-tip {
      font-size: 0.74rem;
      color: #888;
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
      transition: background 0.15s ease;
    }

    .btn-send:hover {
      background: #3700b3;
    }

    .btn-send:disabled {
      background: #bbb;
      cursor: not-allowed;
    }

    /* Feature 2: Floating Undo Snackbar */
    .undo-floating-bar {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: #202124;
      color: #fff;
      border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      z-index: 100000;
      min-width: 320px;
      max-width: 92vw;
      animation: slideUpSnack 0.22s ease-out;
    }

    @keyframes slideUpSnack {
      from {
        transform: translate(-50%, 25px);
        opacity: 0;
      }
      to {
        transform: translate(-50%, 0);
        opacity: 1;
      }
    }

    .undo-bar-content {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 18px;
      gap: 16px;
      font-size: 0.88rem;
    }

    .undo-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .btn-undo-action {
      background: transparent;
      border: none;
      color: #8ab4f8;
      font-weight: 700;
      font-size: 0.88rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      cursor: pointer;
      padding: 4px 10px;
      border-radius: 4px;
    }

    .btn-undo-action:hover {
      background: rgba(138, 180, 248, 0.18);
    }

    .btn-send-now {
      background: #6200ee;
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 5px 12px;
      font-weight: 600;
      font-size: 0.82rem;
      cursor: pointer;
    }

    .btn-send-now:hover {
      background: #7c4dff;
    }

    .btn-undo-dismiss {
      background: transparent;
      border: none;
      color: #bbb;
      font-size: 1.25rem;
      cursor: pointer;
      line-height: 1;
      padding: 0 4px;
    }

    .btn-undo-dismiss:hover {
      color: #fff;
    }

    .undo-success {
      color: #81c784;
      font-weight: 500;
    }

    .undo-countdown-line {
      height: 3px;
      background: #8ab4f8;
      transition: width 1s linear;
    }

    .undo-indeterminate-line {
      height: 3px;
      background: linear-gradient(90deg, #6200ee 0%, #00e5ff 50%, #7c4dff 100%);
      background-size: 200% 100%;
      animation: thinBarProgress 1s infinite linear;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this._onKeyDown = (e: KeyboardEvent) => {
      if (this.dialogEl && this.dialogEl.open) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          this._initiateSend();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          this.close();
          return;
        }

        const bodyEl = this.dialogEl.querySelector('#compose-body');
        if (document.activeElement === bodyEl) {
          const key = e.key.toLowerCase();
          if ((e.ctrlKey || e.metaKey) && key === 'b') {
            e.preventDefault();
            this._applyFormatting('bold');
          } else if ((e.ctrlKey || e.metaKey) && key === 'i') {
            e.preventDefault();
            this._applyFormatting('italic');
          } else if ((e.ctrlKey || e.metaKey) && key === 'u') {
            e.preventDefault();
            this._applyFormatting('underline');
          }
        }
      }
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this._onKeyDown);
    if (this._undoIntervalTimer) clearInterval(this._undoIntervalTimer);
    if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);
  }

  private _getDraftKey(): string {
    return this.threadId ? `draft_thread_${this.threadId}` : 'draft_compose_modal';
  }

  async open(
    prefillTo = '',
    prefillSubject = '',
    prefillBody = '',
    inReplyTo = '',
    threadId = '',
    prefillCc = '',
    prefillBcc = ''
  ) {
    this.error = '';
    this.draftBannerNotice = '';
    this.recoveryStack.clear();

    const isExplicitPrefill = Boolean(prefillTo || prefillSubject || prefillBody || inReplyTo || threadId);

    if (isExplicitPrefill) {
      this.to = prefillTo;
      this.cc = prefillCc;
      this.bcc = prefillBcc;
      this.showCc = Boolean(prefillCc);
      this.showBcc = Boolean(prefillBcc);
      this.subject = prefillSubject;
      this.bodyText = prefillBody;
      this.inReplyTo = inReplyTo;
      this.threadId = threadId;

      // Check for cached draft attachments
      const draftKey = this._getDraftKey();
      const cachedAtts = await getStagedDraftAttachments(draftKey);
      this.attachments = cachedAtts && cachedAtts.length > 0 ? cachedAtts : [];
    } else {
      // Check for existing saved draft in localStorage
      const draftKey = 'draft_compose_modal';
      const savedRaw = localStorage.getItem(`kaposong_umail_${draftKey}`);
      if (savedRaw) {
        try {
          const parsed = JSON.parse(savedRaw);
          this.to = parsed.to || '';
          this.cc = parsed.cc || '';
          this.bcc = parsed.bcc || '';
          this.showCc = Boolean(this.cc);
          this.showBcc = Boolean(this.bcc);
          this.subject = parsed.subject || '';
          this.bodyText = parsed.bodyText || '';
          this.inReplyTo = parsed.inReplyTo || '';
          this.threadId = parsed.threadId || '';
          this.draftBannerNotice = 'Restored unsaved draft';
        } catch {
          this._resetForm();
        }
      } else {
        this._resetForm();
      }

      const cachedAtts = await getStagedDraftAttachments(draftKey);
      this.attachments = cachedAtts && cachedAtts.length > 0 ? cachedAtts : [];
    }

    this.draftStatus = this.bodyText || this.subject || this.to ? 'saved' : 'idle';
    this.dialogEl?.showModal();
  }

  public close() {
    this.dialogEl?.close();
  }

  private _handleInput(field: 'to' | 'cc' | 'bcc' | 'subject' | 'bodyText', val: string) {
    (this as unknown as Record<string, unknown>)[field] = val;
    this._triggerAutoSave();
  }

  private _toggleCc() {
    this.showCc = true;
    this.updateComplete.then(() => {
      const el = this.dialogEl?.querySelector('#compose-cc') as HTMLInputElement | null;
      el?.focus();
    });
  }

  private _removeCc() {
    this.showCc = false;
    this.cc = '';
    this._triggerAutoSave();
  }

  private _toggleBcc() {
    this.showBcc = true;
    this.updateComplete.then(() => {
      const el = this.dialogEl?.querySelector('#compose-bcc') as HTMLInputElement | null;
      el?.focus();
    });
  }

  private _removeBcc() {
    this.showBcc = false;
    this.bcc = '';
    this._triggerAutoSave();
  }

  // Feature 1: Background Auto-Save Draft
  private _triggerAutoSave() {
    if (this._autoSaveTimer) {
      clearTimeout(this._autoSaveTimer);
    }
    this.draftStatus = 'saving';
    this._autoSaveTimer = window.setTimeout(async () => {
      await this._saveDraftNow();
    }, 450);
  }

  private async _saveDraftNow() {
    const key = this._getDraftKey();
    const hasContent =
      this.to.trim() ||
      this.cc.trim() ||
      this.bcc.trim() ||
      this.subject.trim() ||
      this.bodyText.trim() ||
      this.attachments.length > 0;

    if (!hasContent) {
      await this._clearDraftStorage(key);
      this.draftStatus = 'idle';
      return;
    }

    const payload = {
      to: this.to,
      cc: this.cc,
      bcc: this.bcc,
      subject: this.subject,
      bodyText: this.bodyText,
      inReplyTo: this.inReplyTo,
      threadId: this.threadId,
      updatedAt: Date.now(),
    };

    try {
      localStorage.setItem(`kaposong_umail_${key}`, JSON.stringify(payload));
      if (this.attachments.length > 0) {
        await saveStagedDraftAttachments(key, this.attachments);
      }
      const now = new Date();
      this.draftSavedAt = `${now.getHours().toString().padStart(2, '0')}:${now
        .getMinutes()
        .toString()
        .padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
      this.draftStatus = 'saved';
    } catch (e) {
      console.warn('Failed to auto-save draft to storage:', e);
      this.draftStatus = 'idle';
    }
  }

  private async _clearDraftStorage(key: string) {
    try {
      localStorage.removeItem(`kaposong_umail_${key}`);
      await clearStagedDraftAttachments(key);
    } catch {}
  }

  private async _discardDraft() {
    const key = this._getDraftKey();
    await this._clearDraftStorage(key);
    this._resetForm();
    this.close();
    window.dispatchEvent(
      new CustomEvent('show-toast', {
        detail: { message: 'Draft discarded', type: 'info' },
        bubbles: true,
        composed: true,
      })
    );
  }

  private _resetForm() {
    this.to = '';
    this.cc = '';
    this.bcc = '';
    this.showCc = false;
    this.showBcc = false;
    this.subject = '';
    this.bodyText = '';
    this.inReplyTo = '';
    this.threadId = '';
    this.attachments = [];
    this.recoveryStack.clear();
    this.draftStatus = 'idle';
    this.draftSavedAt = '';
    this.draftBannerNotice = '';
    this.error = '';
    this._pendingSendPayload = undefined;
  }

  // Feature 3: Rich Text Formatting Toolbar
  private _applyFormatting(
    type: 'bold' | 'italic' | 'underline' | 'quote' | 'bullet' | 'number' | 'code' | 'clear'
  ) {
    const textarea = this.dialogEl?.querySelector('#compose-body') as HTMLTextAreaElement | null;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = this.bodyText.substring(start, end);
    let replacement = '';
    let cursorOffset = 0;

    switch (type) {
      case 'bold':
        replacement = `**${selected || 'bold text'}**`;
        cursorOffset = selected ? replacement.length : 2;
        break;
      case 'italic':
        replacement = `*${selected || 'italic text'}*`;
        cursorOffset = selected ? replacement.length : 1;
        break;
      case 'underline':
        replacement = `_${selected || 'underlined text'}_`;
        cursorOffset = selected ? replacement.length : 1;
        break;
      case 'quote':
        replacement = selected
          ? selected
              .split('\n')
              .map((l) => `> ${l}`)
              .join('\n')
          : '> Quoted text';
        cursorOffset = replacement.length;
        break;
      case 'bullet':
        replacement = selected
          ? selected
              .split('\n')
              .map((l) => `- ${l}`)
              .join('\n')
          : '- List item';
        cursorOffset = replacement.length;
        break;
      case 'number':
        replacement = selected
          ? selected
              .split('\n')
              .map((l, i) => `${i + 1}. ${l}`)
              .join('\n')
          : '1. List item';
        cursorOffset = replacement.length;
        break;
      case 'code':
        if (selected.includes('\n')) {
          replacement = `\`\`\`\n${selected}\n\`\`\``;
        } else {
          replacement = `\`${selected || 'code'}\``;
        }
        cursorOffset = replacement.length;
        break;
      case 'clear':
        replacement = selected
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/\*([^*]+)\*/g, '$1')
          .replace(/_([^_]+)_/g, '$1')
          .replace(/^>\s*/gm, '')
          .replace(/^-\s*/gm, '')
          .replace(/^\d+\.\s*/gm, '')
          .replace(/`([^`]+)`/g, '$1');
        cursorOffset = replacement.length;
        break;
    }

    this.bodyText = this.bodyText.substring(0, start) + replacement + this.bodyText.substring(end);
    this._triggerAutoSave();

    this.updateComplete.then(() => {
      textarea.focus();
      textarea.setSelectionRange(start + cursorOffset, start + cursorOffset);
    });
  }

  // Feature 2: Initiate Send with Undo Countdown
  private _initiateSend() {
    if (this.sending) return;
    const allRcpts = [this.to, this.cc, this.bcc].filter(Boolean).join(',');
    if (!allRcpts.includes('@')) {
      this.error = 'Please enter at least one valid recipient email address.';
      return;
    }

    this._pendingSendPayload = {
      to: this.to.trim(),
      cc: this.cc.trim(),
      bcc: this.bcc.trim(),
      subject: this.subject.trim() || '(No Subject)',
      bodyText: this.bodyText,
      bodyHtml: markdownToHtml(this.bodyText),
      attachments: [...this.attachments],
      inReplyTo: this.inReplyTo || undefined,
      threadId: this.threadId || undefined,
    };

    this.dialogEl?.close();

    this.undoActive = true;
    this.undoState = 'countdown';
    this.undoSecondsRemaining = 7;
    this.undoTotalSeconds = 7;
    const firstRcpt =
      this.to.split(/[,;]/)[0].trim() ||
      this.cc.split(/[,;]/)[0].trim() ||
      this.bcc.split(/[,;]/)[0].trim();
    this.undoStatusText = `Sending message to ${firstRcpt} in 7s...`;

    if (this._undoIntervalTimer) {
      clearInterval(this._undoIntervalTimer);
    }

    this._undoIntervalTimer = window.setInterval(() => {
      this.undoSecondsRemaining--;
      if (this.undoSecondsRemaining <= 0) {
        if (this._undoIntervalTimer) clearInterval(this._undoIntervalTimer);
        this._executeSend();
      } else {
        this.undoStatusText = `Sending message to ${firstRcpt} in ${this.undoSecondsRemaining}s...`;
      }
    }, 1000);
  }

  private _handleUndo() {
    if (this._undoIntervalTimer) {
      clearInterval(this._undoIntervalTimer);
      this._undoIntervalTimer = undefined;
    }
    this.undoActive = false;
    this.undoState = 'countdown';
    this.draftBannerNotice = 'Send undone. Message kept as draft.';
    this.dialogEl?.showModal();
    this.updateComplete.then(() => {
      const textarea = this.dialogEl?.querySelector('#compose-body') as HTMLTextAreaElement | null;
      textarea?.focus();
    });
  }

  private _handleSendNow() {
    if (this._undoIntervalTimer) {
      clearInterval(this._undoIntervalTimer);
      this._undoIntervalTimer = undefined;
    }
    this._executeSend();
  }

  private async _executeSend() {
    if (!this._pendingSendPayload) return;
    this.undoState = 'transmitting';
    this.undoStatusText =
      this._pendingSendPayload.attachments.length > 0
        ? `Transmitting MIME payload with ${this._pendingSendPayload.attachments.length} attachment(s) via Cloudflare...`
        : 'Transmitting signed MIME envelope via Cloudflare SMTPS relay...';

    try {
      const res = await mailService.sendMessage(
        this._pendingSendPayload.to,
        this._pendingSendPayload.subject,
        this._pendingSendPayload.bodyText,
        this._pendingSendPayload.bodyHtml,
        this._pendingSendPayload.inReplyTo,
        this._pendingSendPayload.threadId,
        this._pendingSendPayload.attachments,
        this._pendingSendPayload.cc || undefined,
        this._pendingSendPayload.bcc || undefined
      );

      const provider = res.delivery_provider ?? 'Cloudflare Email Service';
      const isExternal = res.relayed_externally === true;

      this.undoState = 'sent';
      this.undoStatusText = isExternal
        ? `✓ Sent & delivered to ${this._pendingSendPayload.to} via ${provider}`
        : `✓ Saved in Sent mailbox (${provider}). External delivery queued.`;

      const draftKey = this._getDraftKey();
      await this._clearDraftStorage(draftKey);
      this._resetForm();

      window.dispatchEvent(
        new CustomEvent('email-sent', {
          detail: {
            to: this._pendingSendPayload.to,
            provider,
            relayedExternally: isExternal,
            message: this.undoStatusText,
          },
        })
      );

      setTimeout(() => {
        if (this.undoState === 'sent') {
          this.undoActive = false;
        }
      }, 4500);
    } catch (err: unknown) {
      this.undoActive = false;
      this.error = err instanceof Error ? err.message : 'Failed to send message';
      this.dialogEl?.showModal();
    }
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

      const draftKey = this._getDraftKey();
      await saveStagedDraftAttachments(draftKey, this.attachments);
      this._triggerAutoSave();
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

      const draftKey = this._getDraftKey();
      await saveStagedDraftAttachments(draftKey, this.attachments);
      this._triggerAutoSave();
    }
  }

  private async _undoRemoveAttachment() {
    const popped = this.recoveryStack.pop();
    if (popped) {
      this.attachments = [...this.attachments, popped];
      const draftKey = this._getDraftKey();
      await saveStagedDraftAttachments(draftKey, this.attachments);
      this._triggerAutoSave();
      this.requestUpdate();
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
          <div class="modal-header-left">
            <h2 id="compose-title">
              ${this.inReplyTo ? '↩ Reply to Message' : 'Compose New Email'}
            </h2>
            ${this.draftStatus === 'saved'
              ? html`<span class="draft-header-badge">☁️ Draft</span>`
              : ''}
          </div>
          <button type="button" class="close-btn" @click=${this.close} aria-label="Close compose dialog">
            &times;
          </button>
        </div>

        ${this.draftBannerNotice
          ? html`
              <div class="draft-restore-banner">
                <span>📝 ${this.draftBannerNotice}</span>
                <button type="button" @click=${this._discardDraft}>Discard</button>
              </div>
            `
          : ''}

        <form @submit=${(e: Event) => { e.preventDefault(); this._initiateSend(); }}>
          <div class="sender-tag">
            From: <strong>${user?.name ?? 'User'} &lt;${user?.email ?? ''}&gt;</strong>
            <br />
            <small style="color: #6200ee; font-weight: 600;">
              ✓ Cloudflare Email Service Active • Verified Domain: ${user?.domain ?? 'liparola.org'}
            </small>
          </div>

          <!-- To Field Row with Cc / Bcc Toggle Buttons -->
          <div class="field">
            <div class="field-label-row">
              <label for="compose-to">To (Recipient Emails)</label>
              <div class="recipient-toggle-links">
                ${!this.showCc
                  ? html`<button
                      type="button"
                      class="btn-toggle-field"
                      @click=${this._toggleCc}
                      title="Add Carbon Copy recipients">
                      + Cc
                    </button>`
                  : ''}
                ${!this.showBcc
                  ? html`<button
                      type="button"
                      class="btn-toggle-field"
                      @click=${this._toggleBcc}
                      title="Add Blind Carbon Copy recipients">
                      + Bcc
                    </button>`
                  : ''}
              </div>
            </div>
            <input
              id="compose-to"
              type="text"
              required
              autofocus
              placeholder="e.g. client@organization.co.ls, manager@example.com"
              .value=${this.to}
              ?disabled=${this.sending}
              @input=${(e: Event) =>
                this._handleInput('to', (e.target as HTMLInputElement).value)}
            />
          </div>

          <!-- Collapsible Cc Row -->
          ${this.showCc
            ? html`
                <div class="field">
                  <div class="field-label-row">
                    <label for="compose-cc">Cc (Carbon Copy)</label>
                    <button
                      type="button"
                      class="btn-remove-field"
                      title="Remove Cc"
                      @click=${this._removeCc}>
                      &times;
                    </button>
                  </div>
                  <input
                    id="compose-cc"
                    type="text"
                    placeholder="e.g. colleague@liparola.org, accounts@company.com"
                    .value=${this.cc}
                    ?disabled=${this.sending}
                    @input=${(e: Event) =>
                      this._handleInput('cc', (e.target as HTMLInputElement).value)}
                  />
                </div>
              `
            : ''}

          <!-- Collapsible Bcc Row -->
          ${this.showBcc
            ? html`
                <div class="field">
                  <div class="field-label-row">
                    <label for="compose-bcc">Bcc (Blind Carbon Copy — Private)</label>
                    <button
                      type="button"
                      class="btn-remove-field"
                      title="Remove Bcc"
                      @click=${this._removeBcc}>
                      &times;
                    </button>
                  </div>
                  <input
                    id="compose-bcc"
                    type="text"
                    placeholder="e.g. archive@liparola.org, legal@audit.com"
                    .value=${this.bcc}
                    ?disabled=${this.sending}
                    @input=${(e: Event) =>
                      this._handleInput('bcc', (e.target as HTMLInputElement).value)}
                  />
                </div>
              `
            : ''}

          <!-- Subject Row -->
          <div class="field">
            <label for="compose-subject">Subject</label>
            <input
              id="compose-subject"
              type="text"
              required
              placeholder="Proposal, invoice or discussion topic"
              .value=${this.subject}
              ?disabled=${this.sending}
              @input=${(e: Event) =>
                this._handleInput('subject', (e.target as HTMLInputElement).value)}
            />
          </div>

          <!-- Message Body with Feature 3 Formatting Toolbar & Feature 1 Status -->
          <div class="field">
            <label for="compose-body">Message</label>

            <div class="formatting-toolbar">
              <div class="fmt-buttons">
                <button
                  type="button"
                  class="btn-fmt"
                  title="Bold (Ctrl+B)"
                  @click=${() => this._applyFormatting('bold')}>
                  <strong>B</strong>
                </button>
                <button
                  type="button"
                  class="btn-fmt"
                  title="Italic (Ctrl+I)"
                  @click=${() => this._applyFormatting('italic')}>
                  <em>I</em>
                </button>
                <button
                  type="button"
                  class="btn-fmt"
                  title="Underline (Ctrl+U)"
                  @click=${() => this._applyFormatting('underline')}>
                  <u>U</u>
                </button>
                <span class="fmt-divider"></span>
                <button
                  type="button"
                  class="btn-fmt"
                  title="Blockquote"
                  @click=${() => this._applyFormatting('quote')}>
                  &rdquo;
                </button>
                <button
                  type="button"
                  class="btn-fmt"
                  title="Bullet List"
                  @click=${() => this._applyFormatting('bullet')}>
                  &bull;
                </button>
                <button
                  type="button"
                  class="btn-fmt"
                  title="Numbered List"
                  @click=${() => this._applyFormatting('number')}>
                  1.
                </button>
                <button
                  type="button"
                  class="btn-fmt"
                  title="Code / Monospace"
                  @click=${() => this._applyFormatting('code')}>
                  &lt;&gt;
                </button>
                <button
                  type="button"
                  class="btn-fmt"
                  title="Clear formatting"
                  @click=${() => this._applyFormatting('clear')}>
                  Tx
                </button>
              </div>

              <div class="draft-status-pill">
                ${this.draftStatus === 'saving'
                  ? html`<span class="saving">⏳ Saving draft...</span>`
                  : this.draftStatus === 'saved'
                  ? html`<span class="saved" title="Auto-saved in background">☁️ Saved ${this.draftSavedAt}</span>`
                  : ''}
              </div>
            </div>

            <textarea
              id="compose-body"
              required
              placeholder="Write your email here... (Supports formatting: Ctrl+B for bold, Ctrl+I for italic)"
              .value=${this.bodyText}
              ?disabled=${this.sending}
              @input=${(e: Event) =>
                this._handleInput('bodyText', (e.target as HTMLTextAreaElement).value)}></textarea>
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

          <div class="actions">
            <div class="actions-left">
              <button
                type="button"
                class="btn-discard"
                title="Discard this draft"
                @click=${this._discardDraft}>
                🗑️ Discard Draft
              </button>
              <span class="shortcut-tip">Press <strong>Ctrl+Enter</strong> to send</span>
            </div>

            <div class="actions-right">
              <button
                type="button"
                class="btn-cancel"
                @click=${this.close}
                ?disabled=${this.sending}>
                Close
              </button>
              <button
                type="submit"
                class="btn-send"
                ?disabled=${this.sending || this.isReadingAttachment}>
                🚀 Send Email
              </button>
            </div>
          </div>
        </form>
      </dialog>

      <!-- Feature 2: Floating Undo Send Snackbar -->
      ${this.undoActive
        ? html`
            <div class="undo-floating-bar" role="alert" aria-live="assertive">
              <div class="undo-bar-content">
                <div class="undo-message">
                  ${this.undoState === 'countdown'
                    ? html`<span>⏱️ ${this.undoStatusText}</span>`
                    : ''}
                  ${this.undoState === 'transmitting'
                    ? html`<span>⏳ ${this.undoStatusText}</span>`
                    : ''}
                  ${this.undoState === 'sent'
                    ? html`<span class="undo-success">${this.undoStatusText}</span>`
                    : ''}
                </div>
                <div class="undo-actions">
                  ${this.undoState === 'countdown'
                    ? html`
                        <button type="button" class="btn-undo-action" @click=${this._handleUndo}>
                          UNDO
                        </button>
                        <button type="button" class="btn-send-now" @click=${this._handleSendNow}>
                          Send Now
                        </button>
                      `
                    : ''}
                  ${this.undoState === 'sent'
                    ? html`
                        <button
                          type="button"
                          class="btn-undo-dismiss"
                          @click=${() => (this.undoActive = false)}>
                          &times;
                        </button>
                      `
                    : ''}
                </div>
              </div>
              ${this.undoState === 'countdown'
                ? html`
                    <div
                      class="undo-countdown-line"
                      style="width: ${(this.undoSecondsRemaining / this.undoTotalSeconds) * 100}%;"></div>
                  `
                : ''}
              ${this.undoState === 'transmitting'
                ? html`<div class="undo-indeterminate-line"></div>`
                : ''}
            </div>
          `
        : ''}
    `;
  }
}
