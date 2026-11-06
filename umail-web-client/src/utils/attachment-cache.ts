// ============================================================================
// KA-POSONG RESILIENT ATTACHMENT STAGING, RECOVERY QUEUE & CACHE (src/utils/attachment-cache.ts)
// Implements 120MB maximum constraint, safe MIME parsing, disaster-recovery queues,
// LIFO back-popping stacks, and local IndexedDB temporary holding space
// ============================================================================

import { openDB, type IDBPDatabase } from 'idb';
import type { EmailAttachment } from '../services/mail';

export const MAX_ATTACHMENT_SIZE_BYTES = 120 * 1024 * 1024; // 120MB max constraint
export const MAX_TOTAL_ATTACHMENTS_BYTES = 120 * 1024 * 1024; // 120MB total constraint

const DB_NAME = 'kaposong_umail_attachments_v1';
const DB_VERSION = 1;
const STORE_DRAFTS = 'draft_attachments';
const STORE_DOWNLOADS = 'download_blobs';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
          db.createObjectStore(STORE_DRAFTS, { keyPath: 'draftKey' });
        }
        if (!db.objectStoreNames.contains(STORE_DOWNLOADS)) {
          db.createObjectStore(STORE_DOWNLOADS, { keyPath: 'cacheKey' });
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Validates a candidate attachment file against 120MB size constraint and security criteria
 */
export function validateAttachmentFile(
  file: File,
  existingTotalBytes = 0
): { valid: boolean; error?: string } {
  if (file.size <= 0) {
    return { valid: false, error: `File "${file.name}" is empty (0 bytes).` };
  }

  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      error: `File "${file.name}" (${sizeMb} MB) exceeds the strict 120 MB maximum limit.`,
    };
  }

  if (existingTotalBytes + file.size > MAX_TOTAL_ATTACHMENTS_BYTES) {
    const totalMb = ((existingTotalBytes + file.size) / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      error: `Adding "${file.name}" brings total attachments size to ${totalMb} MB, which exceeds the 120 MB maximum limit.`,
    };
  }

  return { valid: true };
}

/**
 * Sanitizes attachment filename to prevent path traversal or special characters
 */
export function sanitizeFilename(name: string): string {
  const clean = name
    .replace(/[\0\r\n\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return clean.length > 180 ? clean.slice(0, 180) : clean || 'attachment.bin';
}

/**
 * Safely parses a browser File object into an EmailAttachment payload with progress tracking
 */
export async function fileToAttachmentPayload(
  file: File,
  onProgress?: (percent: number) => void
): Promise<EmailAttachment> {
  const validation = validateAttachmentFile(file);
  if (!validation.valid) {
    throw new Error(validation.error || 'Invalid attachment file');
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onprogress = (evt) => {
      if (evt.lengthComputable && onProgress) {
        const percent = Math.round((evt.loaded / evt.total) * 100);
        onProgress(percent);
      }
    };

    reader.onerror = () => {
      reject(new Error(`Failed to read file "${file.name}": ${reader.error?.message}`));
    };

    reader.onload = () => {
      try {
        const arrayBuffer = reader.result as ArrayBuffer;
        const bytes = new Uint8Array(arrayBuffer);
        
        // Chunked binary to base64 encoding to prevent stack overflow on large files
        let binary = '';
        const chunkSize = 0x8000; // 32KB chunks
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
        }
        const base64 = btoa(binary);

        const mimeType = file.type || 'application/octet-stream';
        resolve({
          filename: sanitizeFilename(file.name),
          content_type: mimeType,
          content_base64: base64,
          size_bytes: file.size,
          disposition: 'attachment',
        });
      } catch (err) {
        reject(new Error(`Base64 encoding failed for "${file.name}": ${err}`));
      }
    };

    reader.readAsArrayBuffer(file);
  });
}

/**
 * Disaster Recovery LIFO Stack for backing-pop and recovering attachment drafts on network failure
 */
export class AttachmentRecoveryStack {
  private stack: EmailAttachment[] = [];

  push(attachment: EmailAttachment): void {
    this.stack.push(attachment);
  }

  pop(): EmailAttachment | undefined {
    return this.stack.pop();
  }

  peek(): EmailAttachment | undefined {
    return this.stack[this.stack.length - 1];
  }

  size(): number {
    return this.stack.length;
  }

  getAll(): EmailAttachment[] {
    return [...this.stack];
  }

  clear(): void {
    this.stack = [];
  }
}

/**
 * Outbound Dispatch FIFO Queue for staged attachments
 */
export class AttachmentDispatchQueue {
  private queue: EmailAttachment[] = [];

  enqueue(attachment: EmailAttachment): void {
    this.queue.push(attachment);
  }

  dequeue(): EmailAttachment | undefined {
    return this.queue.shift();
  }

  peek(): EmailAttachment | undefined {
    return this.queue[0];
  }

  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  totalBytes(): number {
    return this.queue.reduce((acc, a) => acc + (a.size_bytes || 0), 0);
  }

  getAll(): EmailAttachment[] {
    return [...this.queue];
  }

  clear(): void {
    this.queue = [];
  }
}

/**
 * Persistent Staging Storage: saves draft attachments in IndexedDB so flaky network disconnects
 * or page reloads never lose user attachments.
 */
export async function saveStagedDraftAttachments(
  draftKey: string,
  attachments: EmailAttachment[]
): Promise<void> {
  try {
    const db = await getDB();
    await db.put(STORE_DRAFTS, {
      draftKey,
      attachments,
      updatedAt: Date.now(),
    });
  } catch (e) {
    console.warn('[AttachmentCache] Failed to save draft attachments to IndexedDB:', e);
  }
}

/**
 * Retrieves staged draft attachments from IndexedDB
 */
export async function getStagedDraftAttachments(
  draftKey: string
): Promise<EmailAttachment[]> {
  try {
    const db = await getDB();
    const entry = await db.get(STORE_DRAFTS, draftKey);
    return entry?.attachments || [];
  } catch (e) {
    console.warn('[AttachmentCache] Failed to retrieve draft attachments:', e);
    return [];
  }
}

/**
 * Clears staged draft attachments once email is successfully sent
 */
export async function clearStagedDraftAttachments(draftKey: string): Promise<void> {
  try {
    const db = await getDB();
    await db.delete(STORE_DRAFTS, draftKey);
  } catch (e) {
    console.warn('[AttachmentCache] Failed to clear draft attachments:', e);
  }
}

/**
 * Converts a Base64 string into a native Blob
 */
export function base64ToBlob(base64: string, contentType: string): Blob {
  const cleanB64 = base64.replace(/\s+/g, '');
  const byteChars = atob(cleanB64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: contentType });
}

/**
 * Triggers safe browser download of an attachment, utilizing IndexedDB download cache
 */
export async function downloadAttachmentBlob(
  att: EmailAttachment,
  messageId?: string
): Promise<void> {
  const cacheKey = `${messageId || 'adhoc'}_${att.filename}`;
  let blob: Blob | null = null;

  try {
    const db = await getDB();
    const cached = await db.get(STORE_DOWNLOADS, cacheKey);
    if (cached?.blob) {
      blob = cached.blob;
    }
  } catch {
    // Fall back to direct conversion
  }

  if (!blob) {
    blob = base64ToBlob(att.content_base64, att.content_type || 'application/octet-stream');
    try {
      const db = await getDB();
      await db.put(STORE_DOWNLOADS, {
        cacheKey,
        blob,
        filename: att.filename,
        sizeBytes: att.size_bytes,
        timestamp: Date.now(),
      });
    } catch {
      // Non-critical cache failure
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = sanitizeFilename(att.filename);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Formats byte count into humanized readable units (KB, MB)
 */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Returns a friendly icon based on file extension and MIME type
 */
export function getAttachmentIcon(filename: string, contentType = ''): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const ct = contentType.toLowerCase();

  if (ct.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) {
    return '🖼️';
  }
  if (ct === 'application/pdf' || ext === 'pdf') {
    return '📄';
  }
  if (
    ct.includes('spreadsheet') ||
    ct.includes('excel') ||
    ['xls', 'xlsx', 'csv'].includes(ext)
  ) {
    return '📊';
  }
  if (
    ct.includes('word') ||
    ct.includes('document') ||
    ['doc', 'docx', 'odt'].includes(ext)
  ) {
    return '📝';
  }
  if (
    ct.includes('zip') ||
    ct.includes('compressed') ||
    ct.includes('tar') ||
    ['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)
  ) {
    return '📦';
  }
  if (ct.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) {
    return '🎵';
  }
  if (ct.startsWith('video/') || ['mp4', 'webm', 'mov', 'mkv'].includes(ext)) {
    return '🎬';
  }
  if (['json', 'txt', 'md', 'html', 'xml', 'log'].includes(ext)) {
    return '📄';
  }
  return '📎';
}
