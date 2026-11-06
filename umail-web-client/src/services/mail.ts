import { authService } from './auth';

export interface EmailAttachment {
  filename: string;
  content_type: string;
  content_base64: string;
  size_bytes: number;
  cid?: string;
  disposition?: string;
}

export interface MailMessage {
  id: string;
  folder: 'inbox' | 'sent' | 'drafts' | 'archive' | 'trash';
  sender_name: string;
  sender_email: string;
  recipient_email: string;
  subject: string;
  preview: string;
  body_text: string;
  body_html?: string;
  is_read: boolean;
  is_starred: boolean;
  spf_dmarc_status: string;
  received_at: string;
  in_reply_to?: string;
  thread_id?: string;
  has_attachments?: boolean;
  attachments?: EmailAttachment[];
}

class MailService extends EventTarget {
  async fetchMessages(folder = 'inbox', searchQuery = ''): Promise<MailMessage[]> {
    const token = authService.getToken();
    if (!token) return [];

    const params = new URLSearchParams({ folder });
    if (searchQuery.trim()) {
      params.set('q', searchQuery.trim());
    }

    const res = await fetch(`${authService.getApiBase()}/api/umail/messages?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!res.ok) {
      throw new Error(`Failed to load messages (${res.status})`);
    }

    const data = (await res.json()) as { messages: MailMessage[] };
    return data.messages ?? [];
  }

  async fetchThread(threadId: string): Promise<MailMessage[]> {
    const token = authService.getToken();
    if (!token || !threadId) return [];

    const res = await fetch(`${authService.getApiBase()}/api/umail/thread/${encodeURIComponent(threadId)}`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!res.ok) {
      return [];
    }

    const data = (await res.json()) as { messages: MailMessage[] };
    return data.messages ?? [];
  }

  async sendMessage(
    to: string,
    subject: string,
    bodyText: string,
    bodyHtml?: string,
    inReplyTo?: string,
    threadId?: string,
    attachments?: EmailAttachment[]
  ): Promise<{
    status: string;
    delivery_provider?: string;
    relayed_externally?: boolean;
    message_id?: string;
  }> {
    const token = authService.getToken();
    if (!token) throw new Error('Not authenticated');

    const res = await fetch(`${authService.getApiBase()}/api/umail/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        to,
        subject,
        body_text: bodyText,
        body_html: bodyHtml,
        in_reply_to: inReplyTo,
        thread_id: threadId,
        attachments: attachments && attachments.length > 0 ? attachments : undefined
      })
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `Failed to send email (${res.status})`);
    }

    const result = (await res.json()) as {
      status: string;
      delivery_provider?: string;
      relayed_externally?: boolean;
      message_id?: string;
    };
    this.dispatchEvent(new CustomEvent('mail-updated'));
    return result;
  }

  async updateMessage(
    id: string,
    patch: { is_read?: boolean; is_starred?: boolean; folder?: string }
  ): Promise<void> {
    const token = authService.getToken();
    if (!token) return;

    await fetch(`${authService.getApiBase()}/api/umail/messages/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(patch)
    });

    this.dispatchEvent(new CustomEvent('mail-updated'));
  }

  async emptyTrash(): Promise<{ status: string; purged_count: number }> {
    const token = authService.getToken();
    if (!token) throw new Error('Not authenticated');

    const res = await fetch(`${authService.getApiBase()}/api/umail/trash`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `Failed to empty trash (${res.status})`);
    }

    const result = (await res.json()) as { status: string; purged_count: number };
    this.dispatchEvent(new CustomEvent('mail-updated'));
    return result;
  }

  async deleteMessagePermanently(id: string): Promise<void> {
    const token = authService.getToken();
    if (!token) return;

    await fetch(`${authService.getApiBase()}/api/umail/messages/${id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    this.dispatchEvent(new CustomEvent('mail-updated'));
  }
}

export const mailService = new MailService();
