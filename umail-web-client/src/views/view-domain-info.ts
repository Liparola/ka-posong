import { LitElement, html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { authService, detectTenantDomain } from '../services/auth';

@customElement('view-domain-info')
export class ViewDomainInfo extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 8px;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
      border-left: 4px solid #6200ee;
      margin-bottom: 16px;
    }
    h3 {
      margin: 0 0 8px 0;
      color: #1a1a2e;
    }
    p {
      margin: 4px 0;
      font-size: 0.9rem;
      color: #555;
    }
    code {
      background: #f3ebff;
      color: #6200ee;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.82rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
      font-size: 0.84rem;
    }
    th,
    td {
      text-align: left;
      padding: 10px;
      border-bottom: 1px solid #eee;
    }
    th {
      background: #f9f9fc;
      color: #444;
      font-weight: 700;
    }
  `;

  render() {
    const user = authService.getUser();
    const domain = user?.domain ?? detectTenantDomain();

    return html`
      <div class="card">
        <h3>Tenant Domain &amp; UMANG Identity Status (${domain})</h3>
        <p>
          <strong>Active Mailbox:</strong> <code>${user?.email ?? ''}</code> bound to Lesotho Phone
          <code>${user?.phone ?? ''}</code>
        </p>
        <p>
          <strong>Control Plane Gateway:</strong>
          <code>${authService.getApiBase()}</code>
        </p>
      </div>

      <div class="card">
        <h3>Cloudflare DNS &amp; DKIM Records for ${domain}</h3>
        <p>
          Add these records in your Cloudflare DNS dashboard so external senders (Gmail, Outlook)
          route seamlessly into your local Stalwart engine over Tailscale Funnel:
        </p>
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Name / Host</th>
              <th>Content / Value</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>MX</strong></td>
              <td><code>@</code></td>
              <td><code>10 route1.mx.cloudflare.net</code></td>
              <td>Cloudflare Email Routing Inbound Port 25 Catch-All</td>
            </tr>
            <tr>
              <td><strong>TXT</strong></td>
              <td><code>@</code></td>
              <td><code>v=spf1 include:_spf.mx.cloudflare.net a:aurum-thinkpad-t440p.tail8fafd0.ts.net ~all</code></td>
              <td>SPF Sender Authorization</td>
            </tr>
            <tr>
              <td><strong>TXT</strong></td>
              <td><code>kaposong._domainkey</code></td>
              <td><code>v=DKIM1; k=ed25519; p=849428b0c988a5d8e...</code></td>
              <td>Stalwart Cryptographic DKIM Public Key</td>
            </tr>
            <tr>
              <td><strong>TXT</strong></td>
              <td><code>_dmarc</code></td>
              <td><code>v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}</code></td>
              <td>DMARC Anti-Spoofing Policy</td>
            </tr>
            <tr>
              <td><strong>CNAME</strong></td>
              <td><code>webmail</code></td>
              <td><code>aurum-thinkpad-t440p.tail8fafd0.ts.net</code></td>
              <td>Tailscale Funnel JMAP &amp; Control Plane Endpoint</td>
            </tr>
          </tbody>
        </table>
      </div>
    `;
  }
}
