import { authService } from './auth';

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

  async sendMessage(to: string, subject: string, bodyText: string): Promise<void> {
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
        body_text: bodyText
      })
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `Failed to send email (${res.status})`);
    }

    this.dispatchEvent(new CustomEvent('mail-updated'));
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
}

export const mailService = new MailService();
