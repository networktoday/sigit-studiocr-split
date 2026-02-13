import sgMail from '@sendgrid/mail';

let connectionSettings: any;

async function getCredentials() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? 'repl ' + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
    ? 'depl ' + process.env.WEB_REPL_RENEWAL
    : null;

  if (!xReplitToken) {
    throw new Error('X_REPLIT_TOKEN not found for repl/depl');
  }

  connectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=sendgrid',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  if (!connectionSettings || (!connectionSettings.settings.api_key || !connectionSettings.settings.from_email)) {
    throw new Error('SendGrid not connected');
  }
  return { apiKey: connectionSettings.settings.api_key, email: connectionSettings.settings.from_email };
}

async function getUncachableSendGridClient() {
  const { apiKey, email } = await getCredentials();
  sgMail.setApiKey(apiKey);
  return {
    client: sgMail,
    fromEmail: email
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email) && email.length <= 254;
}

interface ConversionEmailData {
  recipientEmail: string;
  fileCount: number;
  totalSize: number;
  fileDetails: Array<{
    name: string;
    size: number;
    verified: boolean;
    conformance: string | null;
    wasSplit: boolean;
    parts?: number;
  }>;
  downloadUrl: string;
}

export async function sendConversionEmail(data: ConversionEmailData): Promise<void> {
  if (!isValidEmail(data.recipientEmail)) {
    throw new Error('Indirizzo email non valido');
  }

  const { client, fromEmail } = await getUncachableSendGridClient();

  const totalMB = (data.totalSize / 1024 / 1024).toFixed(2);

  const fileListHtml = data.fileDetails.map(f => {
    const sizeMB = (f.size / 1024 / 1024).toFixed(2);
    const status = f.verified ? `✅ ${escapeHtml(f.conformance || '')}` : '⚠️ Non conforme';
    const splitInfo = f.wasSplit ? ` (diviso in ${f.parts} parti)` : '';
    return `<li style="padding:6px 0;border-bottom:1px solid #eee;">${escapeHtml(f.name)}${splitInfo} — ${sizeMB} MB — ${status}</li>`;
  }).join('');

  const html = `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
      <div style="background:linear-gradient(135deg,#1e40af,#3b82f6);padding:32px 24px;text-align:center;">
        <h1 style="color:#fff;margin:0;font-size:22px;">Conversione PDF/A-1b Completata</h1>
        <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px;">I tuoi file sono pronti per il download</p>
      </div>
      <div style="padding:24px;">
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin-bottom:20px;">
          <p style="margin:0;color:#166534;font-weight:600;">
            ${data.fileCount} file convertit${data.fileCount === 1 ? 'o' : 'i'} — ${totalMB} MB totali
          </p>
        </div>
        <h3 style="margin:0 0 12px;font-size:15px;color:#374151;">Dettaglio file:</h3>
        <ul style="list-style:none;padding:0;margin:0 0 20px;font-size:14px;color:#4b5563;">
          ${fileListHtml}
        </ul>
        <div style="text-align:center;margin:24px 0;">
          <a href="${data.downloadUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">
            Scarica Archivio ZIP
          </a>
        </div>
        <p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:16px;">
          Tutti i file generati rispettano il limite di 9MB per compatibilità SIGIT (Tribunale Telematico).
          <br>Il link di download è valido finché i file non vengono scaricati.
        </p>
      </div>
      <div style="background:#f9fafb;padding:16px 24px;text-align:center;border-top:1px solid #e5e7eb;">
        <p style="margin:0;font-size:12px;color:#9ca3af;">Convertitore PDF/A-1b — ISO 19005-1</p>
      </div>
    </div>
  `;

  await client.send({
    to: data.recipientEmail,
    from: fromEmail,
    subject: `Conversione PDF/A-1b completata — ${data.fileCount} file pront${data.fileCount === 1 ? 'o' : 'i'}`,
    html,
  });
}
