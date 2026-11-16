import { LitElement, html, css } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { mailService, type MailMessage, type EmailAttachment } from '../services/mail';
import { authService, detectTenantDomain } from '../services/auth';
import {
  normalizeMailMessage,
  safeSetEmailHTML,
  groupMessagesIntoThreads,
  type NormalizedMailMessage,
  type EmailThread,
} from '../utils/mime-renderer';
import {
  downloadAttachmentBlob,
  formatBytes,
  getAttachmentIcon,
  validateAttachmentFile,
  fileToAttachmentPayload,
} from '../utils/attachment-cache';

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
  @state() private inlineReplyAttachments: EmailAttachment[] = [];
  @state() private inlineReplyReading = false;
  @state() private inlineReplyReadingProgress = '';
  @state() private inlineReplySending = false;
  @state() private inlineReplyStage = '';
  @state() private inlineReplyNotice = '';
  @state() private inlineReplyError = '';

  // Attachment Preview Lightbox State
  @state() private previewModalAttachment: EmailAttachment | null = null;
  @state() private previewModalOpen = false;

  // Toast Banner State
  @state() private toastMessage = '';
  @state() private toastType: 'success' | 'warning' | 'error' = 'success';
  private _toastTimeout?: number;

  // Mobile Master-Detail State (Gmail Android UX: list-only vs detail-only on mobile)
  @state() private mobileReaderOpen = false;

  @query('#inline-reply-file-input') private inlineFileInputEl?: HTMLInputElement;

  private _mailUpdateHandler!: () => void;
  private _emailSentHandler!: (e: Event) => void;
  private _closeMobileReaderHandler!: () => void;
  private _popStateHandler!: () => void;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      box-sizing: border-box;
      overflow: hidden;
    }

    .mailbox-shell {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
      overflow: hidden;
      position: relative;
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

    .btn-action.btn-danger {
      border-color: #fecdd3;
      color: #e11d48;
      background: #fff1f2;
    }

    .btn-action.btn-danger:hover {
      background: #ffe4e6;
      border-color: #fda4af;
    }

    .trash-banner {
      background: #fff1f2;
      border: 1px solid #fecdd3;
      border-radius: 10px;
      padding: 10px 16px;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 0.85rem;
      color: #9f1239;
    }

    .btn-empty-trash {
      background: #e11d48;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 6px 14px;
      font-weight: 700;
      font-size: 0.82rem;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background 0.15s;
      white-space: nowrap;
    }

    .btn-empty-trash:hover {
      background: #be123c;
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
      position: relative;
      overflow: hidden;
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

    .sent-toast {
      position: fixed;
      top: 20px;
      right: 24px;
      z-index: 9999;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 18px;
      background: #1b5e20;
      color: #fff;
      font-size: 0.9rem;
      font-weight: 600;
      border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
      animation: toastSlideIn 0.35s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .sent-toast.warning {
      background: #e65100;
    }

    .sent-toast.error {
      background: #c62828;
    }

    @keyframes toastSlideIn {
      from {
        opacity: 0;
        transform: translateY(-20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
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

    /* Message Attachments Section & Cards */
    .message-attachments-section {
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px dashed #dcd5f2;
    }

    .attachments-header {
      font-size: 0.82rem;
      font-weight: 700;
      color: #444;
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;
    }

    .attachments-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 10px;
    }

    .attachment-card {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      background: #fbfbfe;
      border: 1px solid #e2e2ec;
      border-radius: 10px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
      transition: all 0.15s ease;
    }

    .attachment-card:hover {
      border-color: #6200ee;
      box-shadow: 0 2px 6px rgba(98, 0, 238, 0.08);
    }

    .att-icon {
      font-size: 1.5rem;
      line-height: 1;
    }

    .att-meta {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }

    .att-name {
      font-size: 0.84rem;
      font-weight: 600;
      color: #333;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .att-size {
      font-size: 0.74rem;
      color: #777;
    }

    .att-actions {
      display: flex;
      gap: 4px;
    }

    .btn-att-action {
      background: #f0f0f8;
      border: 1px solid #d0d0e0;
      color: #333;
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 0.75rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.12s;
    }

    .btn-att-action:hover {
      background: #6200ee;
      color: #fff;
      border-color: #6200ee;
    }

    /* Staged Attachment Chips in Inline Reply */
    .inline-attachment-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 4px;
    }

    .inline-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #fff;
      border: 1px solid #d4c8f0;
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 0.78rem;
    }

    .inline-chip .btn-remove {
      background: transparent;
      border: none;
      color: #888;
      font-weight: bold;
      cursor: pointer;
      font-size: 0.9rem;
      line-height: 1;
      padding: 0 2px;
    }

    .inline-chip .btn-remove:hover {
      color: #d32f2f;
    }

    /* Lightbox / Preview Modal */
    .preview-modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(15, 12, 28, 0.75);
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .preview-modal-content {
      background: #fff;
      border-radius: 14px;
      max-width: 90vw;
      max-height: 90vh;
      width: 780px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.4);
    }

    .preview-modal-header {
      padding: 12px 18px;
      background: #f7f6fc;
      border-bottom: 1px solid #e4e2f0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 600;
      font-size: 0.9rem;
    }

    .preview-modal-body {
      padding: 16px;
      overflow: auto;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 250px;
      max-height: 70vh;
      background: #fafafc;
    }

    .preview-modal-footer {
      padding: 10px 18px;
      background: #f7f6fc;
      border-top: 1px solid #e4e2f0;
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }

    .msg-bottom-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .msg-star-btn {
      background: transparent;
      border: none;
      padding: 0 2px;
      font-size: 1.15rem;
      line-height: 1;
      cursor: pointer;
      flex-shrink: 0;
      transition: transform 0.12s ease;
    }

    .msg-star-btn:hover {
      transform: scale(1.18);
    }

    .date-dot-group {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .unread-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #1a73e8;
      display: inline-block;
      flex-shrink: 0;
    }

    /* Mobile-only elements hidden on desktop (>= 900px) */
    .mobile-folder-heading,
    .mobile-compose-fab,
    .mobile-reader-topbar {
      display: none;
    }

    /* ============================================================================
       GMAIL ANDROID MOBILE VIEW (< 900px)
       Single-pane Master-Detail architecture:
       - List mode: Full-screen scrollable conversation list + floating Compose pill
       - Reader mode: Full-screen thread reader with sticky back/action toolbar
       ============================================================================ */
    @media (max-width: 899px) {
      .mailbox-shell {
        background: #fff;
      }

      /* Compact 1-line tenant strip on mobile so list gets maximum screen height */
      .org-banner {
        margin: 8px 12px 4px 12px;
        padding: 8px 14px;
        border-radius: 10px;
        gap: 8px;
        flex-shrink: 0;
      }

      .org-banner h3 {
        font-size: 0.88rem;
      }

      .org-banner small {
        display: none;
      }

      .plan-badge {
        font-size: 0.66rem;
        padding: 3px 9px;
      }

      /* Gmail Android Pill Search Bar on mobile */
      .toolbar {
        margin: 4px 12px 4px 12px;
        gap: 8px;
        flex-shrink: 0;
      }

      .search-box {
        background: #eef1f8;
        border: none;
        border-radius: 28px;
        padding: 10px 16px;
        box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.03);
      }

      .search-box input {
        background: transparent;
        font-size: 0.94rem;
        color: #1f1f1f;
      }

      .search-box input::placeholder {
        color: #5f6368;
      }

      .toolbar .btn-action {
        border-radius: 20px;
        padding: 8px 12px;
        font-size: 0.78rem;
        background: #eef1f8;
        border: none;
        color: #444746;
      }

      .trash-banner {
        margin: 4px 12px 6px 12px;
        padding: 8px 12px;
        font-size: 0.78rem;
        flex-shrink: 0;
      }

      /* Gmail Android Category / Folder Label */
      .mobile-folder-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 16px 4px 16px;
        font-size: 0.76rem;
        font-weight: 600;
        color: #5f6368;
        letter-spacing: 0.02em;
        flex-shrink: 0;
      }

      .split-pane {
        display: flex;
        flex-direction: column;
        flex: 1;
        gap: 0;
        overflow: hidden;
      }

      /* LIST MODE on Mobile: Hide reader-pane completely, give message-list 100% height */
      .mailbox-shell.mobile-list-open .reader-pane {
        display: none !important;
      }

      .mailbox-shell.mobile-list-open .message-list {
        flex: 1;
        height: 100%;
        border: none;
        border-radius: 0;
        box-shadow: none;
        overflow-y: auto;
        padding-bottom: 88px;
        overscroll-behavior: contain;
      }

      /* Gmail Android Conversation Row Styling */
      .msg-row {
        padding: 12px 16px;
        gap: 14px;
        border-bottom: none;
        border-left: none;
        align-items: flex-start;
      }

      .msg-row.active {
        background: transparent;
      }

      .msg-row.unread {
        background: #fff;
      }

      .msg-row:active {
        background: #f2f4fa;
      }

      .avatar-circle {
        width: 42px;
        height: 42px;
        font-size: 0.95rem;
        font-weight: 600;
        margin-top: 2px;
      }

      .msg-top {
        margin-bottom: 2px;
      }

      .sender {
        font-size: 0.96rem;
        font-weight: 500;
        color: #1f1f1f;
      }

      .msg-row.unread .sender {
        font-weight: 700;
        color: #000;
      }

      .date {
        font-size: 0.76rem;
        color: #444746;
      }

      .msg-row.unread .date {
        color: #1f1f1f;
        font-weight: 700;
      }

      .subject {
        font-size: 0.88rem;
        font-weight: 400;
        color: #444746;
        margin-bottom: 2px;
      }

      .msg-row.unread .subject {
        font-weight: 700;
        color: #1f1f1f;
      }

      .preview {
        font-size: 0.84rem;
        color: #5f6368;
      }

      /* Floating Gmail Android Compose Pill Button on Mobile */
      .mailbox-shell.mobile-list-open .mobile-compose-fab {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 30;
        background: #e8def8;
        color: #1d192b;
        border: none;
        border-radius: 16px;
        padding: 14px 20px;
        font-size: 0.95rem;
        font-weight: 600;
        box-shadow: 0 4px 14px rgba(29, 25, 43, 0.22);
        cursor: pointer;
        transition: transform 0.15s ease, box-shadow 0.15s ease;
      }

      .mailbox-shell.mobile-list-open .mobile-compose-fab:active {
        transform: scale(0.96);
      }

      /* READER MODE on Mobile: Hide list & top bars, give reader-pane 100% height */
      .mailbox-shell.mobile-reader-open .org-banner,
      .mailbox-shell.mobile-reader-open .toolbar,
      .mailbox-shell.mobile-reader-open .trash-banner,
      .mailbox-shell.mobile-reader-open .mobile-folder-heading,
      .mailbox-shell.mobile-reader-open .message-list,
      .mailbox-shell.mobile-reader-open .mobile-compose-fab {
        display: none !important;
      }

      .mailbox-shell.mobile-reader-open .reader-pane {
        flex: 1;
        height: 100%;
        border: none;
        border-radius: 0;
        box-shadow: none;
        padding: 0 14px 28px 14px;
        overflow-y: auto;
        overscroll-behavior: contain;
      }

      /* Sticky Top Action Bar inside Mobile Thread Reader */
      .mobile-reader-topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        position: sticky;
        top: 0;
        z-index: 15;
        background: rgba(255, 255, 255, 0.96);
        backdrop-filter: blur(6px);
        margin: 0 -14px;
        padding: 10px 12px;
        border-bottom: 1px solid #f0f0f5;
      }

      .btn-mobile-back {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: transparent;
        border: none;
        color: #1f1f1f;
        font-size: 0.95rem;
        font-weight: 600;
        padding: 6px 10px;
        border-radius: 20px;
        cursor: pointer;
      }

      .btn-mobile-back:active {
        background: #f0f0f5;
      }

      .mobile-reader-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .thread-header {
        padding-top: 8px;
      }

      .thread-title-row {
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
      }

      .thread-title-row h2 {
        font-size: 1.2rem;
        line-height: 1.35;
        word-break: break-word;
      }

      .msg-card-expanded {
        padding: 14px 12px;
      }

      .sender-card {
        padding: 10px 12px;
      }

      .meta-grid {
        grid-template-columns: 1fr;
        gap: 4px;
      }

      .inline-reply-box {
        padding: 12px 14px;
      }
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this._mailUpdateHandler = () => this.loadFolder();
    mailService.addEventListener('mail-updated', this._mailUpdateHandler);

    this._emailSentHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.message) {
        this._showToast(detail.message, detail.relayedExternally ? 'success' : 'warning');
      }
    };
    window.addEventListener('email-sent', this._emailSentHandler);

    this._closeMobileReaderHandler = () => {
      this.mobileReaderOpen = false;
    };
    window.addEventListener('close-mobile-reader', this._closeMobileReaderHandler);

    this._popStateHandler = () => {
      if (this.mobileReaderOpen) {
        this.mobileReaderOpen = false;
      }
    };
    window.addEventListener('popstate', this._popStateHandler);

    this.loadFolder();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    mailService.removeEventListener('mail-updated', this._mailUpdateHandler);
    window.removeEventListener('email-sent', this._emailSentHandler);
    window.removeEventListener('close-mobile-reader', this._closeMobileReaderHandler);
    window.removeEventListener('popstate', this._popStateHandler);
    if (this._toastTimeout) clearTimeout(this._toastTimeout);
  }

  private _showToast(msg: string, type: 'success' | 'warning' | 'error' = 'success') {
    if (this._toastTimeout) clearTimeout(this._toastTimeout);
    this.toastMessage = msg;
    this.toastType = type;
    this._toastTimeout = window.setTimeout(() => {
      this.toastMessage = '';
    }, 4500);
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('folder')) {
      this.selectedThread = null;
      this.mobileReaderOpen = false;
      this.loadFolder();
    }
    this._syncAllRichBodies();
  }

  private _getAvatarBg(seed: string): string {
    const palette = [
      '#ab47bc', // Orchid Purple (L)
      '#7986cb', // Indigo Lavender (M)
      '#66bb6a', // Sage Green (R)
      '#5c6bc0', // Slate Blue (S)
      '#26c6da', // Cyan Sky (B)
      '#ec407a', // Rose
      '#26a69a', // Teal
      '#7e57c2', // Deep Purple
      '#ffa726', // Amber
    ];
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = seed.charCodeAt(i) + ((hash << 5) - hash);
    }
    return palette[Math.abs(hash) % palette.length];
  }

  private _getFolderLabel(): string {
    switch (this.folder) {
      case 'inbox':
        return 'Primary';
      case 'sent':
        return 'Sent';
      case 'starred':
        return 'Starred';
      case 'archive':
        return 'Archive';
      case 'trash':
        return 'Trash';
      default:
        return this.folder;
    }
  }

  private _closeMobileReader() {
    this.mobileReaderOpen = false;
  }

  private _openMobileCompose() {
    this.dispatchEvent(
      new CustomEvent('open-compose', {
        detail: {},
        bubbles: true,
        composed: true,
      })
    );
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

    if (typeof window !== 'undefined' && window.innerWidth < 900 && !this.mobileReaderOpen) {
      this.mobileReaderOpen = true;
      try {
        window.history.pushState({ umailMobileReader: true }, '');
      } catch {
        // Ignore history pushState restrictions
      }
    } else {
      this.mobileReaderOpen = true;
    }

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
    this.mobileReaderOpen = false;
    await this.loadFolder();
  }

  private async _confirmEmptyTrash() {
    if (
      !confirm(
        'Are you sure you want to permanently delete all messages in Trash?\n\n' +
        'This will permanently purge all trashed messages and attachments from local and cloud storage. ' +
        'This action cannot be undone.'
      )
    ) {
      return;
    }
    try {
      this.loading = true;
      const res = await mailService.emptyTrash();
      this.toastMessage = `Trash emptied permanently. ${res.purged_count} message(s) deleted.`;
      this.toastType = 'success';
      this.selectedThread = null;
      this.mobileReaderOpen = false;
      await this.loadFolder();
    } catch (err: any) {
      this.toastMessage = `Failed to empty trash: ${err.message}`;
      this.toastType = 'error';
    } finally {
      this.loading = false;
    }
  }

  private async _confirmDeleteThreadPermanently(thread: EmailThread) {
    if (
      !confirm(
        'Are you sure you want to permanently delete this conversation and all its messages?\n\n' +
        'This will permanently purge this conversation from cloud storage. This action cannot be undone.'
      )
    ) {
      return;
    }
    try {
      for (const m of thread.messages) {
        await mailService.deleteMessagePermanently(m.id);
      }
      this.toastMessage = 'Conversation permanently deleted.';
      this.toastType = 'success';
      this.selectedThread = null;
      this.mobileReaderOpen = false;
      await this.loadFolder();
    } catch (err: any) {
      this.toastMessage = `Failed to delete conversation: ${err.message}`;
      this.toastType = 'error';
    }
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
    this.inlineReplyStage = 'Contacting Cloudflare edge relay...';
    this.inlineReplyError = '';
    this.inlineReplyNotice = '';

    const stageTimer = setTimeout(() => {
      this.inlineReplyStage = this.inlineReplyAttachments.length > 0
        ? `Transmitting MIME envelope with ${this.inlineReplyAttachments.length} attachment(s)...`
        : 'Transmitting RFC 5322 MIME envelope...';
    }, 450);

    try {
      const res = await mailService.sendMessage(
        to,
        subject,
        text,
        undefined,
        latest.id,
        this.selectedThread.threadKey.replace(/^tid_/, '').replace(/^subj_/, ''),
        this.inlineReplyAttachments
      );
      clearTimeout(stageTimer);
      this.inlineReplyText = '';
      this.inlineReplyAttachments = [];

      const provider = res.delivery_provider ?? 'Cloudflare Email Service';
      const isExternal = res.relayed_externally === true;

      if (isExternal) {
        this._showToast(`✓ Reply sent & delivered to ${to} via ${provider}`, 'success');
      } else {
        this._showToast(
          `✓ Reply saved to Sent folder (${provider}). External delivery queued.`,
          'warning'
        );
      }
      await this.loadFolder();
    } catch (err: unknown) {
      clearTimeout(stageTimer);
      this.inlineReplyError = err instanceof Error ? err.message : 'Failed to send reply';
      this._showToast(`⚠️ Failed to send reply: ${this.inlineReplyError}`, 'error');
    } finally {
      this.inlineReplySending = false;
      this.inlineReplyStage = '';
    }
  }

  private async _handleInlineFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const files = Array.from(input.files);
    input.value = '';
    this.inlineReplyError = '';

    const currentTotal = this.inlineReplyAttachments.reduce((acc, a) => acc + (a.size_bytes || 0), 0);
    let runningTotal = currentTotal;

    for (const f of files) {
      const val = validateAttachmentFile(f, runningTotal);
      if (!val.valid) {
        this.inlineReplyError = val.error || `File ${f.name} cannot be attached.`;
        return;
      }
      runningTotal += f.size;
    }

    this.inlineReplyReading = true;
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        this.inlineReplyReadingProgress = `Staging ${f.name} (${i + 1}/${files.length})...`;
        const att = await fileToAttachmentPayload(f, (pct) => {
          this.inlineReplyReadingProgress = `Encoding ${f.name}: ${pct}%`;
        });
        this.inlineReplyAttachments = [...this.inlineReplyAttachments, att];
      }
    } catch (err: unknown) {
      this.inlineReplyError = err instanceof Error ? err.message : 'Error attaching file';
    } finally {
      this.inlineReplyReading = false;
      this.inlineReplyReadingProgress = '';
    }
  }

  private _removeInlineAttachment(idx: number) {
    this.inlineReplyAttachments = this.inlineReplyAttachments.filter((_, i) => i !== idx);
  }

  private _canPreview(att: EmailAttachment): boolean {
    const ext = att.filename.split('.').pop()?.toLowerCase() || '';
    const ct = (att.content_type || '').toLowerCase();
    return (
      ct.startsWith('image/') ||
      ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext) ||
      ct === 'application/pdf' ||
      ext === 'pdf' ||
      ['txt', 'json', 'md', 'log', 'csv', 'html', 'xml'].includes(ext)
    );
  }

  private _openAttachmentPreview(att: EmailAttachment) {
    this.previewModalAttachment = att;
    this.previewModalOpen = true;
  }

  private _closeAttachmentPreview() {
    this.previewModalOpen = false;
    this.previewModalAttachment = null;
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
      <div class="mailbox-shell ${this.mobileReaderOpen ? 'mobile-reader-open' : 'mobile-list-open'}">
        ${this.toastMessage
          ? html`
              <div class="sent-toast ${this.toastType}">
                <span>${this.toastMessage}</span>
                <button
                  style="background:transparent; border:none; color:#fff; cursor:pointer; font-weight:bold; font-size:1.1rem; line-height:1;"
                  @click=${() => (this.toastMessage = '')}>
                  &times;
                </button>
              </div>
            `
          : ''}

        <div class="org-banner">
          <div>
            <h3>${user?.email ?? 'uMail Inbox'}</h3>
            <small>
              UMANG Phone ID: ${user?.phone ?? ''} • Domain: ${user?.domain ?? detectTenantDomain()} •
              Cloudflare Email Routing &amp; Sending (Beta)
            </small>
          </div>
          <span class="plan-badge">${user?.subscription ?? 'ENTERPRISE'} TIER</span>
        </div>

        <div class="toolbar">
          <div class="search-box">
            <input
              type="search"
              placeholder="Search in emails"
              .value=${this.searchQuery}
              @input=${(e: Event) => {
                this.searchQuery = (e.target as HTMLInputElement).value;
                this.loadFolder();
              }}
            />
          </div>
          ${this.folder === 'trash' && this.threads.length > 0
            ? html`
                <button
                  class="btn-action btn-danger"
                  @click=${() => this._confirmEmptyTrash()}>
                  🗑️ Empty Trash Now
                </button>
              `
            : ''}
          <button class="btn-action" @click=${() => this.loadFolder()}>↻ Refresh</button>
        </div>

        ${this.folder === 'trash' && this.threads.length > 0
          ? html`
              <div class="trash-banner">
                <span>⚠️ Messages in Trash can be permanently purged. This will delete all trashed messages and attachments from local and cloud storage.</span>
                <button class="btn-empty-trash" @click=${() => this._confirmEmptyTrash()}>
                  🗑️ Empty Trash Now
                </button>
              </div>
            `
          : ''}

        <!-- Gmail Android Category / Folder Label on Mobile -->
        <div class="mobile-folder-heading">
          <span>${this._getFolderLabel()}</span>
          <span>${this.threads.length} ${this.threads.length === 1 ? 'conversation' : 'conversations'}</span>
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
                  const avatarColor = this._getAvatarBg(latest.senderDisplayName || latest.senderInitials);
                  return html`
                    <div
                      class="msg-row ${t.unreadCount > 0 ? 'unread' : ''} ${isSelected ? 'active' : ''}"
                      @click=${() => this._selectThread(t)}>
                      <div class="avatar-circle" style="background: ${avatarColor};">${latest.senderInitials}</div>
                      <div class="msg-content">
                        <div class="msg-top">
                          <span class="sender">
                            ${t.participantsSummary}
                            ${t.hasReplies
                              ? html`<span class="thread-pill">${t.messages.length}</span>`
                              : ''}
                            ${t.participants.some((p) => p.isSelf)
                              ? html`<span class="replied-tag">↩ Replied</span>`
                              : ''}
                            ${t.messages.some((m) => m.has_attachments || (m.attachments && m.attachments.length > 0))
                              ? html`<span class="thread-pill" style="background:#eef2ff;color:#4338ca;">📎</span>`
                              : ''}
                          </span>
                          <span class="date-dot-group">
                            <span class="date">${t.lastDateShort}</span>
                            ${t.unreadCount > 0
                              ? html`<span class="unread-dot" title="Unread message"></span>`
                              : ''}
                          </span>
                        </div>
                        <div class="subject">${t.cleanSubject}</div>
                        <div class="msg-bottom-row">
                          <div class="preview">${latest.cleanPreview}</div>
                          <button
                            type="button"
                            class="msg-star-btn"
                            style="color:${t.isStarred ? '#f59e0b' : '#b0b4be'};"
                            title="${t.isStarred ? 'Starred' : 'Not starred'}"
                            @click=${(e: Event) => this._toggleStar(t, e)}>
                            ${t.isStarred ? '★' : '☆'}
                          </button>
                        </div>
                      </div>
                    </div>
                  `;
                })}
          </div>

          <!-- Conversation Reader Pane -->
          <div class="reader-pane">
            ${thread
              ? html`
                  <!-- Gmail Android Mobile Top Action Bar (only visible on < 900px) -->
                  <div class="mobile-reader-topbar">
                    <button
                      type="button"
                      class="btn-mobile-back"
                      @click=${() => this._closeMobileReader()}
                      aria-label="Back to conversation list">
                      ← Back
                    </button>
                    <div class="mobile-reader-actions">
                      ${this.folder === 'trash'
                        ? html`
                            <button
                              class="btn-action"
                              style="padding: 5px 10px; font-size: 0.78rem;"
                              @click=${() => this._moveThreadFolder(thread, 'inbox')}>
                              ↩ Restore
                            </button>
                            <button
                              class="btn-action btn-danger"
                              style="padding: 5px 10px; font-size: 0.78rem;"
                              @click=${() => this._confirmDeleteThreadPermanently(thread)}>
                              ❌ Delete
                            </button>
                          `
                        : html`
                            <button
                              class="btn-action"
                              style="padding: 5px 10px; font-size: 0.78rem;"
                              @click=${() => this._moveThreadFolder(thread, 'archive')}>
                              📥 Archive
                            </button>
                            <button
                              class="btn-action"
                              style="padding: 5px 10px; font-size: 0.78rem;"
                              @click=${() => this._moveThreadFolder(thread, 'trash')}>
                              🗑 Trash
                            </button>
                          `}
                      <button
                        type="button"
                        class="msg-star-btn"
                        style="color:${thread.isStarred ? '#f59e0b' : '#9ca3af'}; font-size: 1.3rem; padding: 0 6px;"
                        @click=${(e: Event) => this._toggleStar(thread, e)}>
                        ${thread.isStarred ? '★' : '☆'}
                      </button>
                    </div>
                  </div>

                  <div class="thread-header">
                  <div class="thread-title-row">
                    <h2>${thread.cleanSubject}</h2>
                    <span class="spf-badge">✓ ${thread.latestMessage.spf_dmarc_status}</span>
                  </div>
                  <div class="thread-meta-bar">
                    <span class="thread-tag">🧵 ${thread.messages.length} messages in conversation</span>
                    <span class="thread-tag">Cloudflare Verified Domain</span>
                    ${this.folder === 'trash'
                      ? html`
                          <button
                            class="btn-action"
                            style="padding: 2px 8px; font-size: 0.75rem;"
                            @click=${() => this._moveThreadFolder(thread, 'inbox')}>
                            ↩ Restore to Inbox
                          </button>
                          <button
                            class="btn-action btn-danger"
                            style="padding: 2px 8px; font-size: 0.75rem;"
                            @click=${() => this._confirmDeleteThreadPermanently(thread)}>
                            ❌ Delete Permanently
                          </button>
                        `
                      : html`
                          <button
                            class="btn-action"
                            style="padding: 2px 8px; font-size: 0.75rem;"
                            @click=${() => this._moveThreadFolder(thread, 'archive')}>
                            📥 Archive
                          </button>
                          <button
                            class="btn-action"
                            style="padding: 2px 8px; font-size: 0.75rem;"
                            @click=${() => this._moveThreadFolder(thread, 'trash')}>
                            🗑 Trash
                          </button>
                        `}
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

                        ${m.attachments && m.attachments.length > 0
                          ? html`
                              <div class="message-attachments-section">
                                <div class="attachments-header">
                                  <span>📎 Attachments (${m.attachments.length})</span>
                                  <span style="font-size:0.78rem;color:#777;">
                                    Total: ${formatBytes(m.attachments.reduce((acc, a) => acc + (a.size_bytes || 0), 0))}
                                  </span>
                                </div>
                                <div class="attachments-grid">
                                  ${m.attachments.map(
                                    (att) => html`
                                      <div class="attachment-card">
                                        <div class="att-icon">${getAttachmentIcon(att.filename, att.content_type)}</div>
                                        <div class="att-meta">
                                          <span class="att-name" title="${att.filename}">${att.filename}</span>
                                          <span class="att-size">${formatBytes(att.size_bytes)}</span>
                                        </div>
                                        <div class="att-actions">
                                          ${this._canPreview(att)
                                            ? html`
                                                <button
                                                  type="button"
                                                  class="btn-att-action"
                                                  title="Preview file"
                                                  @click=${() => this._openAttachmentPreview(att)}>
                                                  👁️ Preview
                                                </button>
                                              `
                                            : ''}
                                          <button
                                            type="button"
                                            class="btn-att-action"
                                            title="Download file"
                                            @click=${() => downloadAttachmentBlob(att, m.id)}>
                                            ⬇ Download
                                          </button>
                                        </div>
                                      </div>
                                    `
                                  )}
                                </div>
                              </div>
                            `
                          : ''}
                      </div>
                    `;
                  })}
                </div>

                <!-- Inline Quick Reply Box (Gmail & Outlook UX) -->
                <div class="inline-reply-box">
                  ${this.inlineReplySending ? html`<div class="progress-bar-thin"></div>` : ''}

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
                    placeholder="Write a reply... (Press Ctrl+Enter to send)"
                    .value=${this.inlineReplyText}
                    ?disabled=${this.inlineReplySending}
                    @keydown=${(e: KeyboardEvent) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                        e.preventDefault();
                        this._sendInlineReply();
                      }
                    }}
                    @input=${(e: Event) => {
                      this.inlineReplyText = (e.target as HTMLTextAreaElement).value;
                    }}></textarea>

                  <input
                    id="inline-reply-file-input"
                    type="file"
                    multiple
                    style="display:none;"
                    @change=${this._handleInlineFileSelect}
                  />

                  ${this.inlineReplyReading
                    ? html`<div style="font-size:0.8rem; color:#6200ee; font-weight:600;">
                        ⏳ ${this.inlineReplyReadingProgress}
                      </div>`
                    : ''}

                  ${this.inlineReplyAttachments.length > 0
                    ? html`
                        <div class="inline-attachment-chips">
                          ${this.inlineReplyAttachments.map(
                            (att, idx) => html`
                              <div class="inline-chip">
                                <span>${getAttachmentIcon(att.filename, att.content_type)}</span>
                                <span style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${att.filename}</span>
                                <span style="color:#777;">(${formatBytes(att.size_bytes)})</span>
                                <button type="button" class="btn-remove" @click=${() => this._removeInlineAttachment(idx)}>&times;</button>
                              </div>
                            `
                          )}
                        </div>
                      `
                    : ''}

                  ${this.inlineReplyError
                    ? html`<div style="color: #d32f2f; font-size: 0.82rem; font-weight: 600;">⚠️ ${this.inlineReplyError}</div>`
                    : ''}
                  ${this.inlineReplyNotice
                    ? html`<div style="color: #2e7d32; font-size: 0.84rem; font-weight: 700;">✓ ${this.inlineReplyNotice}</div>`
                    : ''}

                  <div class="reply-actions">
                    <div style="display:flex;gap:6px;align-items:center;">
                      <button
                        class="btn-action"
                        style="padding: 6px 12px; font-size: 0.8rem;"
                        ?disabled=${this.inlineReplySending}
                        @click=${() => this._quoteOriginalText()}>
                        📄 Quote text
                      </button>
                      <button
                        class="btn-action"
                        style="padding: 6px 12px; font-size: 0.8rem;"
                        ?disabled=${this.inlineReplySending || this.inlineReplyReading}
                        @click=${() => this.inlineFileInputEl?.click()}>
                        📎 Attach (Max 120MB)
                      </button>
                    </div>

                    <button
                      class="btn-send-reply"
                      ?disabled=${this.inlineReplySending || this.inlineReplyReading}
                      @click=${() => this._sendInlineReply()}>
                      ${this.inlineReplySending
                        ? html`<span>⏳ ${this.inlineReplyStage || 'Sending reply...'}</span>`
                        : '🚀 Send Reply'}
                    </button>
                  </div>
                </div>
              `
            : html`<div class="empty-state">Select a conversation thread to read messages.</div>`}
          </div>
        </div>

        <!-- Gmail Android Floating Compose Pill Button on Mobile -->
        <button
          type="button"
          class="mobile-compose-fab"
          @click=${() => this._openMobileCompose()}
          aria-label="Compose new email">
          <span style="font-size: 1.1rem;">✎</span> Compose
        </button>

        <!-- Lightbox / Preview Modal for Attachments -->
        ${this.previewModalOpen && this.previewModalAttachment
          ? html`
              <div class="preview-modal-backdrop" @click=${this._closeAttachmentPreview}>
                <div class="preview-modal-content" @click=${(e: Event) => e.stopPropagation()}>
                  <div class="preview-modal-header">
                    <span>
                      ${getAttachmentIcon(this.previewModalAttachment.filename, this.previewModalAttachment.content_type)}
                      ${this.previewModalAttachment.filename} (${formatBytes(this.previewModalAttachment.size_bytes)})
                    </span>
                    <button
                      type="button"
                      class="btn-action"
                      style="padding:4px 8px;font-size:1rem;"
                      @click=${this._closeAttachmentPreview}>
                      &times;
                    </button>
                  </div>
                  <div class="preview-modal-body">
                    ${(this.previewModalAttachment.content_type || '').startsWith('image/')
                      ? html`<img
                          src="data:${this.previewModalAttachment.content_type};base64,${this.previewModalAttachment.content_base64.replace(/\s+/g, '')}"
                          style="max-width:100%;max-height:65vh;object-fit:contain;border-radius:8px;"
                          alt="${this.previewModalAttachment.filename}"
                        />`
                      : this.previewModalAttachment.content_type === 'application/pdf' || this.previewModalAttachment.filename.endsWith('.pdf')
                      ? html`<iframe
                          src="data:application/pdf;base64,${this.previewModalAttachment.content_base64.replace(/\s+/g, '')}"
                          style="width:100%;height:65vh;border:none;"
                        ></iframe>`
                      : html`<pre
                          style="white-space:pre-wrap;word-break:break-word;width:100%;max-height:65vh;overflow:auto;font-family:monospace;font-size:0.88rem;background:#1e1e2e;color:#cdd6f4;padding:16px;border-radius:8px;"
                        >${atob(this.previewModalAttachment.content_base64.replace(/\s+/g, ''))}</pre>`}
                  </div>
                  <div class="preview-modal-footer">
                    <button
                      class="btn-action"
                      @click=${() => downloadAttachmentBlob(this.previewModalAttachment!)}>
                      ⬇ Download
                    </button>
                    <button class="btn-action" @click=${this._closeAttachmentPreview}>Close</button>
                  </div>
                </div>
              </div>
            `
          : ''}
      </div>
    `;
  }
}
