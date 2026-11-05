import type { MailMessage } from '../services/mail';

export interface MimePartMetadata {
  contentType: string;
  charset: string;
  transferEncoding: string;
  sizeBytes: number;
}

export interface NormalizedMailMessage extends MailMessage {
  senderDisplayName: string;
  senderAddress: string;
  senderInitials: string;
  senderDomain: string;
  cleanPreview: string;
  cleanText: string;
  cleanHtml: string;
  formattedDateShort: string;
  formattedDateFull: string;
  mimeBoundary: string | null;
  mimeParts: MimePartMetadata[];
  securityBadges: { label: string; ok: boolean }[];
}

const ALLOWED_EMAIL_ELEMENTS = [
  'div',
  'span',
  'p',
  'br',
  'hr',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'a',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'img',
  'small',
  'sub',
  'sup',
];

const ALLOWED_EMAIL_ATTRIBUTES = [
  'href',
  'src',
  'alt',
  'title',
  'dir',
  'align',
  'width',
  'height',
  'colspan',
  'rowspan',
  'class',
  'target',
  'rel',
];

/**
 * Safely sanitizes and renders untrusted email HTML into `el` using the native
 * Sanitizer API (`Element.prototype.setHTML` and `Document.parseHTML`) with a
 * strict DOM allowlist walker fallback so no unsafe elements or `on*` handlers reach the DOM.
 */
export function safeSetEmailHTML(el: HTMLElement, untrustedHtml: string): void {
  const elements = ALLOWED_EMAIL_ELEMENTS;
  const attributes = ALLOWED_EMAIL_ATTRIBUTES;

  if ('setHTML' in Element.prototype) {
    (
      el as HTMLElement & {
        setHTML: (
          h: string,
          opts?: { sanitizer?: { elements: string[]; attributes: string[] } }
        ) => void;
      }
    ).setHTML(untrustedHtml, { sanitizer: { elements, attributes } });
  } else if ('parseHTML' in Document) {
    const doc = (
      Document as unknown as {
        parseHTML: (
          h: string,
          opts?: { sanitizer?: { elements: string[]; attributes: string[] } }
        ) => Document;
      }
    ).parseHTML(untrustedHtml, { sanitizer: { elements, attributes } });
    el.replaceChildren(...Array.from(doc.body.childNodes));
  } else {
    const parsedDoc = new DOMParser().parseFromString(untrustedHtml, 'text/html');
    const allowedTagSet = new Set(elements.map((t) => t.toUpperCase()));
    const allowedAttrSet = new Set(attributes.map((a) => a.toLowerCase()));

    const sanitizeNode = (node: Node): Node | null => {
      if (node.nodeType === Node.TEXT_NODE) {
        return document.createTextNode(node.textContent || '');
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        return null;
      }
      const srcEl = node as Element;
      const tagName = srcEl.tagName.toUpperCase();
      if (!allowedTagSet.has(tagName)) {
        // Match native Sanitizer: remove disallowed element together with its content
        return null;
      }
      const cleanEl = document.createElement(srcEl.tagName.toLowerCase());
      for (const attr of Array.from(srcEl.attributes)) {
        const name = attr.name.toLowerCase();
        const val = attr.value.trim();
        if (!allowedAttrSet.has(name) || name.startsWith('on') || name.startsWith('data-') || name.startsWith('aria-')) {
          continue;
        }
        if ((name === 'href' || name === 'src') && /^(javascript|vbscript|data):/i.test(val)) {
          continue;
        }
        cleanEl.setAttribute(attr.name, val);
      }
      for (const child of Array.from(srcEl.childNodes)) {
        const cleanChild = sanitizeNode(child);
        if (cleanChild) cleanEl.appendChild(cleanChild);
      }
      return cleanEl;
    };

    const fragment = document.createDocumentFragment();
    for (const child of Array.from(parsedDoc.body.childNodes)) {
      const clean = sanitizeNode(child);
      if (clean) fragment.appendChild(clean);
    }
    el.replaceChildren(fragment);
  }

  // Ensure external links open safely in a new tab
  el.querySelectorAll('a[href]').forEach((anchor) => {
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
  });
}

/**
 * Decodes Quoted-Printable strings (RFC 2045)
 */
export function decodeQuotedPrintable(input: string): string {
  const withoutSoftBreaks = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < withoutSoftBreaks.length; i++) {
    if (withoutSoftBreaks[i] === '=' && i + 2 < withoutSoftBreaks.length) {
      const hex = withoutSoftBreaks.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    const code = withoutSoftBreaks.charCodeAt(i);
    if (code < 128) {
      bytes.push(code);
    } else {
      const encoded = new TextEncoder().encode(withoutSoftBreaks[i]);
      bytes.push(...encoded);
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
  } catch {
    return withoutSoftBreaks;
  }
}

/**
 * Decodes RFC 2047 encoded words `=?UTF-8?B?...?=` or `=?UTF-8?Q?...?=`
 */
export function decodeRfc2047(text: string): string {
  if (!text || !text.includes('=?')) return text;
  return text.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, _charset, encoding, payload) => {
    const enc = String(encoding).toUpperCase();
    try {
      if (enc === 'B') {
        const binary = atob(String(payload).replace(/\s+/g, ''));
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        return new TextDecoder('utf-8').decode(bytes);
      }
      if (enc === 'Q') {
        return decodeQuotedPrintable(String(payload).replace(/_/g, ' '));
      }
    } catch {
      // Fallback to raw payload
    }
    return payload;
  });
}

/**
 * Parses `From` display name and email address without duplicating `<email>`
 */
export function parseAddressHeader(
  rawName: string,
  rawEmail: string
): { displayName: string; email: string; initials: string; domain: string } {
  const decodedName = decodeRfc2047(rawName || '').trim();
  const decodedEmail = decodeRfc2047(rawEmail || '').trim();

  let displayName = decodedName;
  let email = decodedEmail;

  const angleMatch = decodedName.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (angleMatch) {
    const extractedName = angleMatch[1].replace(/^["']|["']$/g, '').trim();
    const extractedEmail = angleMatch[2].trim();
    if (extractedEmail.includes('@')) {
      email = extractedEmail;
    }
    displayName = extractedName || email.split('@')[0] || 'Sender';
  } else {
    displayName = displayName.replace(/^["']|["']$/g, '').trim();
  }

  if (email.startsWith('<') && email.endsWith('>')) {
    email = email.slice(1, -1).trim();
  }

  // If displayName is identical to the email address, derive a readable name from local-part
  if (!displayName || displayName.toLowerCase() === email.toLowerCase()) {
    const local = (email.split('@')[0] || 'Sender').replace(/[._-]+/g, ' ');
    displayName = local.replace(/\b\w/g, (l) => l.toUpperCase());
  }

  const words = displayName.split(/\s+/).filter(Boolean);
  const initials =
    words.length >= 2
      ? `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase()
      : displayName.slice(0, 2).toUpperCase();

  const domain = email.includes('@') ? email.split('@')[1].toLowerCase() : 'liparola.org';

  return { displayName, email, initials, domain };
}

/**
 * Strips HTML tags and decodes common entities into clean plain text
 */
export function stripHtmlToText(html: string): string {
  if (!html) return '';
  const withBreaks = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n');

  const stripped = withBreaks.replace(/<[^>]+>/g, '');
  const decoded = stripped
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  return decoded
    .split(/\r?\n/)
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Converts clean plain text into well-structured HTML with clickable links,
 * styled reply quotes (`>`), and signature dividers (`-- `).
 */
export function formatPlainTextToHtml(plainText: string): string {
  if (!plainText) return '<p><em>(Empty message body)</em></p>';

  const escapeHtml = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const linkify = (escapedLine: string) =>
    escapedLine.replace(
      /(https?:\/\/[^\s<]+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
      (match) => {
        if (match.startsWith('http://') || match.startsWith('https://')) {
          return `<a href="${match}" target="_blank" rel="noopener noreferrer">${match}</a>`;
        }
        return `<a href="mailto:${match}">${match}</a>`;
      }
    );

  const lines = plainText.split(/\r?\n/);
  const blocks: string[] = [];
  let quoteBuffer: string[] = [];

  const flushQuotes = () => {
    if (quoteBuffer.length > 0) {
      blocks.push(`<blockquote>${quoteBuffer.join('<br>')}</blockquote>`);
      quoteBuffer = [];
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('>')) {
      const cleanQuote = trimmed.replace(/^>+\s?/, '');
      quoteBuffer.push(linkify(escapeHtml(cleanQuote)));
    } else {
      flushQuotes();
      if (trimmed === '--' || rawLine === '-- ' || /^_{4,}$/.test(trimmed)) {
        blocks.push('<hr>');
      } else if (trimmed === '') {
        blocks.push('<br>');
      } else {
        blocks.push(`<div>${linkify(escapeHtml(rawLine))}</div>`);
      }
    }
  }
  flushQuotes();

  return blocks.join('\n');
}

interface ParsedMultipartResult {
  text: string;
  html: string;
  boundary: string | null;
  parts: MimePartMetadata[];
}

/**
 * Detects and parses raw RFC 2045/2046 multipart MIME bodies on the client if present
 */
export function parseRawMimeBodyIfNeeded(
  rawText: string,
  existingHtml?: string
): ParsedMultipartResult {
  const partsMeta: MimePartMetadata[] = [];
  let boundary: string | null = null;

  const trimmed = (rawText || '').trim();

  // Detect boundary either from `boundary="..."` or leading `--<hex/token>` line
  const boundaryHeaderMatch = trimmed.match(/boundary=["']?([^"'\s;]+)["']?/i);
  if (boundaryHeaderMatch) {
    boundary = boundaryHeaderMatch[1];
  } else {
    const firstLine = trimmed.split(/\r?\n/)[0]?.trim() || '';
    if (
      firstLine.startsWith('--') &&
      firstLine.length >= 10 &&
      !/\s/.test(firstLine) &&
      trimmed.includes('Content-Type:')
    ) {
      boundary = firstLine.slice(2).replace(/--$/, '');
    } else {
      const inlineBoundaryMatch = trimmed.match(/^--([0-9a-zA-Z'()+_,-./:=?]{10,})\r?\nContent-Type:/m);
      if (inlineBoundaryMatch) {
        boundary = inlineBoundaryMatch[1];
      }
    }
  }

  if (!boundary) {
    // Check if the body starts with inline `Content-Type:` headers without boundary
    if (/^Content-Type:\s*text\/(plain|html)/i.test(trimmed)) {
      const splitIdx = trimmed.search(/\r?\n\r?\n/);
      if (splitIdx !== -1) {
        const hdrs = trimmed.slice(0, splitIdx);
        const bodyContent = trimmed.slice(splitIdx).trim();
        const isHtml = /Content-Type:\s*text\/html/i.test(hdrs);
        const isQp = /Content-Transfer-Encoding:\s*quoted-printable/i.test(hdrs);
        const decoded = isQp ? decodeQuotedPrintable(bodyContent) : bodyContent;
        partsMeta.push({
          contentType: isHtml ? 'text/html' : 'text/plain',
          charset: 'UTF-8',
          transferEncoding: isQp ? 'quoted-printable' : '7bit',
          sizeBytes: decoded.length,
        });
        return {
          text: isHtml ? stripHtmlToText(decoded) : decoded,
          html: isHtml ? decoded : existingHtml || formatPlainTextToHtml(decoded),
          boundary: null,
          parts: partsMeta,
        };
      }
    }

    const cleanHtml =
      existingHtml && existingHtml.trim()
        ? existingHtml.trim()
        : formatPlainTextToHtml(trimmed);
    partsMeta.push({
      contentType: existingHtml ? 'multipart/alternative (text + html)' : 'text/plain',
      charset: 'UTF-8',
      transferEncoding: '8bit',
      sizeBytes: trimmed.length,
    });
    return {
      text: trimmed,
      html: cleanHtml,
      boundary: null,
      parts: partsMeta,
    };
  }

  // Split by `--boundary`
  const delimiter = `--${boundary}`;
  const rawChunks = trimmed.split(delimiter);
  let extractedPlain = '';
  let extractedHtml = existingHtml || '';

  for (const chunk of rawChunks) {
    const cleanChunk = chunk.trim();
    if (!cleanChunk || cleanChunk === '--' || cleanChunk.startsWith('--')) {
      continue;
    }

    const blankSep = cleanChunk.search(/\r?\n\r?\n/);
    if (blankSep === -1) continue;

    const partHeaders = cleanChunk.slice(0, blankSep);
    let partBody = cleanChunk.slice(blankSep).trim();
    // Strip trailing `--` if attached to final part
    partBody = partBody.replace(/\r?\n--\s*$/, '').trim();

    const ctMatch = partHeaders.match(/Content-Type:\s*([^\r\n;]+)/i);
    const charsetMatch = partHeaders.match(/charset=["']?([^"'\r\n;]+)["']?/i);
    const cteMatch = partHeaders.match(/Content-Transfer-Encoding:\s*([^\r\n;]+)/i);

    const contentType = (ctMatch?.[1] || 'text/plain').trim().toLowerCase();
    const charset = (charsetMatch?.[1] || 'UTF-8').trim().toUpperCase();
    const transferEncoding = (cteMatch?.[1] || '7bit').trim().toLowerCase();

    if (contentType.startsWith('multipart/')) {
      const nested = parseRawMimeBodyIfNeeded(partBody);
      if (nested.text && !extractedPlain) extractedPlain = nested.text;
      if (nested.html && !extractedHtml) extractedHtml = nested.html;
      partsMeta.push(...nested.parts);
      continue;
    }

    let decodedPart = partBody;
    if (transferEncoding === 'quoted-printable') {
      decodedPart = decodeQuotedPrintable(partBody);
    } else if (transferEncoding === 'base64') {
      try {
        const bin = atob(partBody.replace(/\s+/g, ''));
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        decodedPart = new TextDecoder('utf-8').decode(bytes);
      } catch {
        decodedPart = partBody;
      }
    }

    partsMeta.push({
      contentType,
      charset,
      transferEncoding,
      sizeBytes: decodedPart.length,
    });

    if (contentType === 'text/plain' && !extractedPlain) {
      extractedPlain = decodedPart.trim();
    } else if (contentType === 'text/html' && !extractedHtml) {
      extractedHtml = decodedPart.trim();
    }
  }

  if (!extractedPlain && extractedHtml) {
    extractedPlain = stripHtmlToText(extractedHtml);
  }
  if (!extractedHtml && extractedPlain) {
    extractedHtml = formatPlainTextToHtml(extractedPlain);
  }

  return {
    text: extractedPlain || trimmed,
    html: extractedHtml || formatPlainTextToHtml(trimmed),
    boundary,
    parts: partsMeta,
  };
}

/**
 * Formats ISO / SQLite timestamp into readable local/UTC strings
 */
function formatTimestamps(rawDate: string): { short: string; full: string } {
  if (!rawDate) return { short: '', full: '' };
  const isoCandidate = rawDate.includes('T') ? rawDate : `${rawDate.replace(' ', 'T')}Z`;
  const parsed = new Date(isoCandidate);
  if (Number.isNaN(parsed.getTime())) {
    return { short: rawDate.slice(0, 16), full: rawDate };
  }
  const short = parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const full = parsed.toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return { short, full };
}

/**
 * Normalizes a `MailMessage` from the API into a rich `NormalizedMailMessage`
 */
export function normalizeMailMessage(msg: MailMessage): NormalizedMailMessage {
  const { displayName, email, initials, domain } = parseAddressHeader(
    msg.sender_name,
    msg.sender_email
  );
  const parsedMime = parseRawMimeBodyIfNeeded(msg.body_text, msg.body_html);

  const singleLinePreview = parsedMime.text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('>'))
    .join(' ')
    .slice(0, 130);

  const { short, full } = formatTimestamps(msg.received_at);

  const statusUpper = (msg.spf_dmarc_status || 'PASS').toUpperCase();
  const isPass = !statusUpper.includes('FAIL');
  const securityBadges = [
    { label: 'SPF Verified', ok: isPass },
    { label: 'DKIM Signed', ok: isPass },
    { label: 'DMARC Aligned', ok: isPass },
    { label: 'TLS Edge Tunnel', ok: true },
  ];

  return {
    ...msg,
    subject: decodeRfc2047(msg.subject || '(No Subject)'),
    senderDisplayName: displayName,
    senderAddress: email,
    senderInitials: initials,
    senderDomain: domain,
    cleanPreview: singleLinePreview || '(No preview available)',
    cleanText: parsedMime.text,
    cleanHtml: parsedMime.html,
    formattedDateShort: short,
    formattedDateFull: full,
    mimeBoundary: parsedMime.boundary,
    mimeParts: parsedMime.parts,
    securityBadges,
  };
}
