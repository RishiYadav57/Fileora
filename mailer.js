/**
 * Production-ready Gmail SMTP Mailer Module for FileCorner
 * Handles validation, sanitization, rate limiting, and email dispatch
 * using Nodemailer over TLS (Port 465).
 */

const nodemailer = require('nodemailer');

// Supported Subject Categories from contact.html
const ALLOWED_CATEGORIES = [
  'Conversion Failure',
  'Formatting or Table Distortion',
  'Privacy or File Deletion Request',
  'Legal or DPDPA Inquiry',
  'Feature Request or Feedback',
  'Other Inquiries'
];

// RFC 5322 compliant email regex check
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

// Sliding-window contact submission rate limiter (Max 5 submissions per 10 minutes per IP)
const contactRateLimits = new Map();
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_SUBMISSIONS_PER_WINDOW = 5;

// Periodically clean up expired rate-limit records
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of contactRateLimits.entries()) {
    if (now > data.resetTime) {
      contactRateLimits.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

/**
 * Check if client IP is within rate limits for contact submissions
 */
function checkContactRateLimit(ip) {
  const now = Date.now();
  let record = contactRateLimits.get(ip);
  if (!record || now > record.resetTime) {
    record = { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS };
    contactRateLimits.set(ip, record);
    return { allowed: true, remaining: MAX_SUBMISSIONS_PER_WINDOW - 1 };
  }

  if (record.count >= MAX_SUBMISSIONS_PER_WINDOW) {
    const retryAfterSec = Math.ceil((record.resetTime - now) / 1000);
    return { allowed: false, retryAfterSec };
  }

  record.count += 1;
  return { allowed: true, remaining: MAX_SUBMISSIONS_PER_WINDOW - record.count };
}

/**
 * Sanitize header strings against CRLF injection attacks (\r, \n)
 */
function sanitizeHeader(str) {
  if (!str) return '';
  return String(str).replace(/[\r\n\t]/g, ' ').trim();
}

/**
 * Escape HTML special characters for safe email template interpolation
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generate a unique human-readable submission reference ID
 */
function generateReferenceId() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `FC-${timestamp}-${random}`;
}

/**
 * Create and configure Nodemailer transporter
 */
function getTransporter() {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const user = process.env.SMTP_USER || 'pdfconverterfreebusiness@gmail.com';
  const pass = (process.env.SMTP_PASS || '').replace(/\s+/g, ''); // Strip any space from app passwords

  if (!pass) {
    throw new Error('SMTP_PASS_NOT_CONFIGURED');
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465 (implicit TLS)
    auth: { user, pass },
    connectionTimeout: 10000, // 10s connection timeout
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
}


/**
 * Shared delivery layer for Contact Support and review notifications.
 *  - SMTP (Gmail, nodemailer) is the default: SMTP_PASS is required, SMTP_USER / SMTP_HOST / SMTP_PORT have defaults.
 *  - RESEND_API_KEY (optional) switches delivery to Resend over HTTPS, for hosts that block outbound SMTP.
 * Every failure is thrown as an Error with a stable `.mailCode` (MAIL_NOT_CONFIGURED, MAIL_AUTH, MAIL_CONNECT, MAIL_REJECTED, MAIL_TIMEOUT)
 * so callers can answer truthfully; messages never contain credentials.
 */
let senderOverride = null;   // test hook: replaces the real transport so automated tests never send mail
function setSenderForTests(fn) { senderOverride = fn || null; }

function mailConfig() {
  if (process.env.RESEND_API_KEY) return { provider: 'resend', ready: true, missing: [] };
  const missing = [];
  if (!(process.env.SMTP_PASS || '').replace(/\s+/g, '')) missing.push('SMTP_PASS');
  return { provider: 'smtp', ready: missing.length === 0, missing };
}

function mailError(code, message, cause) { const e = new Error(message); e.mailCode = code; if (cause && cause.code) e.causeCode = String(cause.code); return e; }

function classify(err) {
  if (err && err.mailCode) return err;
  const c = String((err && (err.code || err.responseCode)) || '');
  const msg = String((err && err.message) || '');
  if (c === 'EAUTH' || /^535|Invalid login|Username and Password not accepted|BadCredentials/i.test(msg)) return mailError('MAIL_AUTH', 'The mail server refused the sign-in (check SMTP_USER and SMTP_PASS; Gmail needs an App Password)', err);
  if (['ECONNECTION', 'ECONNREFUSED', 'ENOTFOUND', 'EDNS', 'ESOCKET', 'ENETUNREACH', 'EHOSTUNREACH'].includes(c)) return mailError('MAIL_CONNECT', 'Could not reach the mail server (outbound SMTP may be blocked by the host)', err);
  if (['ETIMEDOUT', 'ECONNRESET'].includes(c) || /timeout|timed out/i.test(msg)) return mailError('MAIL_TIMEOUT', 'The mail server did not answer in time', err);
  return mailError('MAIL_REJECTED', 'The mail server did not accept the message' + (err && err.responseCode ? ` (SMTP ${err.responseCode})` : ''), err);
}

async function deliver({ from, to, replyTo, subject, text, html, headers, resendFrom }) {
  if (senderOverride) return senderOverride({ from, to, replyTo, subject, text, html, headers });
  const cfg = mailConfig();
  if (!cfg.ready) throw mailError('MAIL_NOT_CONFIGURED', 'Missing configuration: ' + cfg.missing.join(', '));
  if (cfg.provider === 'resend') {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const resp = await fetch(`${(process.env.RESEND_API_BASE || 'https://api.resend.com').replace(/\/+$/, '')}/emails`, {
        method: 'POST', signal: ctl.signal,
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: resendFrom || process.env.FEEDBACK_FROM || 'FileCorner <onboarding@resend.dev>', to: [to], reply_to: replyTo || undefined, subject, text, html })
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) throw mailError(resp.status === 401 || resp.status === 403 ? 'MAIL_AUTH' : 'MAIL_REJECTED', `Resend refused the message (HTTP ${resp.status}${body && body.name ? ' ' + body.name : ''})`);
      return { provider: 'resend', messageId: body.id };
    } catch (e) {
      throw e && e.mailCode ? e : mailError(e && e.name === 'AbortError' ? 'MAIL_TIMEOUT' : 'MAIL_CONNECT', 'Could not reach the mail provider');
    } finally { clearTimeout(timer); }
  }
  try {
    const info = await getTransporter().sendMail({ from, to, replyTo, subject, text, html, headers });
    if (info && Array.isArray(info.rejected) && info.rejected.length && !(info.accepted || []).length) throw mailError('MAIL_REJECTED', 'The recipient address was rejected');
    return { provider: 'smtp', messageId: info.messageId };
  } catch (e) { throw classify(e); }
}

/**
 * Validate and normalize submission fields
 */
function validateSubmission(body) {
  const { name, email, category, message, hp } = body || {};

  // Honeypot check (hidden spam field must be empty)
  if (hp && String(hp).trim().length > 0) {
    return { valid: false, error: 'Spam submission detected.' };
  }

  // Name validation (optional, max 100 chars)
  const cleanName = sanitizeHeader(name || '').slice(0, 100);

  // Email validation (required, valid format, max 254 chars)
  const rawEmail = sanitizeHeader(email || '');
  if (!rawEmail) {
    return { valid: false, error: 'Email address is required.' };
  }
  if (rawEmail.length > 254 || !EMAIL_REGEX.test(rawEmail)) {
    return { valid: false, error: 'Please provide a valid email address.' };
  }
  const cleanEmail = rawEmail.toLowerCase();

  // Category validation
  let cleanCategory = sanitizeHeader(category || 'Other Inquiries');
  if (!ALLOWED_CATEGORIES.includes(cleanCategory)) {
    cleanCategory = 'Other Inquiries';
  }

  // Message validation (required, 10 to 5000 chars)
  const cleanMessage = String(message || '').trim();
  if (!cleanMessage) {
    return { valid: false, error: 'Message description is required.' };
  }
  if (cleanMessage.length < 10) {
    return { valid: false, error: 'Message must be at least 10 characters long.' };
  }
  if (cleanMessage.length > 5000) {
    return { valid: false, error: 'Message exceeds maximum allowed limit of 5,000 characters.' };
  }

  return {
    valid: true,
    data: {
      name: cleanName,
      email: cleanEmail,
      category: cleanCategory,
      message: cleanMessage
    }
  };
}

/**
 * Send Contact Form notification email via Gmail SMTP
 */
async function sendContactEmail(submissionData) {
  const smtpUser = process.env.SMTP_USER || 'pdfconverterfreebusiness@gmail.com';
  const recipient = process.env.CONTACT_TO || 'pdfconverterfreebusiness@gmail.com';
  const referenceId = generateReferenceId();
  const utcTimestamp = new Date().toISOString();
  const readableDate = new Date().toUTCString();

  const { name, email, category, message } = submissionData;
  const displayName = name || 'Anonymous User';

  // Construct Email Subject
  const subject = `[Contact Form - ${category}] ${name ? name + ' - ' : ''}${referenceId}`;

  // Plain-text alternative
  const plainText = [
    `======================================================`,
    `FILECORNER - NEW CONTACT SUBMISSION`,
    `======================================================`,
    ``,
    `Reference ID : ${referenceId}`,
    `Submitted At : ${readableDate} (${utcTimestamp})`,
    `From Name    : ${displayName}`,
    `User Email   : ${email}`,
    `Category     : ${category}`,
    ``,
    `------------------- MESSAGE CONTENT -------------------`,
    message,
    `-------------------------------------------------------`,
    ``,
    `NOTE: Replying directly to this email will send a reply`,
    `to the user at ${email}.`,
    `Website: https://pdfconverterfree.in`
  ].join('\n');

  // Professional, responsive HTML email template
  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; color: #1e293b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
    
    <!-- Header Banner -->
    <tr>
      <td style="padding: 24px 32px; background: linear-gradient(135deg, #1e3a8a 0%, #2563eb 100%); color: #ffffff;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td>
              <h1 style="margin: 0; font-size: 20px; font-weight: 800; letter-spacing: -0.02em;">FileCorner</h1>
              <p style="margin: 4px 0 0 0; font-size: 13px; color: #bfdbfe;">New User Support &amp; Inquiry Submission</p>
            </td>
            <td align="right">
              <span style="display: inline-block; padding: 4px 10px; font-size: 11px; font-weight: 700; font-family: monospace; background-color: rgba(255, 255, 255, 0.2); border-radius: 6px; color: #ffffff;">
                ${escapeHtml(referenceId)}
              </span>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Submission Details Card -->
    <tr>
      <td style="padding: 28px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; margin-bottom: 24px;">
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 0; font-size: 12px; font-weight: 700; color: #64748b; width: 140px; text-transform: uppercase; letter-spacing: 0.05em;">User Name</td>
            <td style="padding: 10px 0; font-size: 14px; font-weight: 600; color: #0f172a;">${escapeHtml(displayName)}</td>
          </tr>
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 0; font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;">User Email</td>
            <td style="padding: 10px 0; font-size: 14px; font-weight: 600; color: #2563eb;">
              <a href="mailto:${escapeHtml(email)}" style="color: #2563eb; text-decoration: none;">${escapeHtml(email)}</a>
            </td>
          </tr>
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 0; font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;">Category</td>
            <td style="padding: 10px 0; font-size: 13px; font-weight: 600; color: #0f172a;">
              <span style="display: inline-block; padding: 3px 8px; border-radius: 6px; background-color: #eff6ff; color: #1d4ed8; font-size: 12px;">
                ${escapeHtml(category)}
              </span>
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 0; font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;">Submitted (UTC)</td>
            <td style="padding: 10px 0; font-size: 13px; font-family: monospace; color: #475569;">${escapeHtml(readableDate)}</td>
          </tr>
        </table>

        <!-- Message Body -->
        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px 20px; margin-bottom: 24px;">
          <h2 style="margin: 0 0 10px 0; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #475569;">Message Description</h2>
          <div style="font-size: 14px; line-height: 1.6; color: #1e293b; white-space: pre-wrap; word-break: break-word;">${escapeHtml(message)}</div>
        </div>

        <!-- Quick Reply Action Callout -->
        <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px; padding: 12px 16px; font-size: 12px; color: #166534; line-height: 1.5;">
          <strong>Direct Reply:</strong> The <code>Reply-To</code> header is set to <strong>${escapeHtml(email)}</strong>. Simply click "Reply" in your email client to respond directly to this user.
        </div>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="padding: 16px 32px; background-color: #f8fafc; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; text-align: center;">
        FileCorner Automated Dispatcher &bull; <a href="https://pdfconverterfree.in" style="color: #64748b; text-decoration: none;">pdfconverterfree.in</a>
      </td>
    </tr>

  </table>
</body>
</html>
  `;

  const mailOptions = {
    from: `"FileCorner Support" <${smtpUser}>`,
    to: recipient,
    replyTo: name ? `"${name}" <${email}>` : email,
    subject: subject,
    text: plainText,
    html: htmlContent,
    headers: {
      'X-Submission-Ref': referenceId,
      'X-Category': category
    }
  };

  const info = await deliver({ ...mailOptions, resendFrom: `FileCorner Support <${process.env.FEEDBACK_FROM_ADDRESS || 'onboarding@resend.dev'}>` });
  return {
    success: true,
    messageId: info.messageId,
    referenceId,
    timestamp: utcTimestamp
  };
}

/**
 * Notification for one download-page review. Everything user-supplied is escaped in the HTML part and stripped of line breaks in the
 * subject. No file names, contents or attachments are included. Throws when delivery fails (the caller keeps the saved review).
 */
async function sendFeedbackEmail(r) {
  const smtpUser = process.env.SMTP_USER || 'pdfconverterfreebusiness@gmail.com';
  const recipient = process.env.FEEDBACK_TO || process.env.CONTACT_TO || 'pdfconverterfreebusiness@gmail.com';
  const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
  const tool = r.tool ? r.tool.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Not specified';
  let country = r.country || 'Not provided';
  try { if (r.country) country = `${new Intl.DisplayNames(['en'], { type: 'region' }).of(r.country)} (${r.country})`; } catch (e) { /* keep the code */ }
  const when = new Date(r.createdAt).toUTCString();
  const rows = [
    ['Rating', `${r.rating}/5  ${stars}`], ['Category', r.categoryLabel], ['Tool', tool], ['Name', r.name || 'Not provided'],
    ['Country', country], ['Submitted', `${when} (${new Date(r.createdAt).toISOString()})`], ['Review ID', r.id]
  ];
  const comment = r.comment || '(no comment)';
  const text = ['NEW FILECORNER USER REVIEW', '', ...rows.map(([k, v]) => `${k.padEnd(10)}: ${v}`), '', '--- Comment ---', comment, '---------------', 'Website: https://pdfconverterfree.in'].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px"><h2 style="margin:0 0 12px">New FileCorner user review</h2>` +
    `<table style="border-collapse:collapse;width:100%">${rows.map(([k, v]) => `<tr><td style="padding:6px 10px;background:#f1f5f9;font-weight:bold;width:110px">${escapeHtml(k)}</td><td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${escapeHtml(v)}</td></tr>`).join('')}</table>` +
    `<h3 style="margin:16px 0 6px">Comment</h3><div style="white-space:pre-wrap;padding:10px;border:1px solid #e2e8f0;border-radius:8px">${escapeHtml(comment)}</div></div>`;
  const subject = sanitizeHeader(`New FileCorner User Review — ${r.rating}/5 Stars`);
  return deliver({ from: `"FileCorner Reviews" <${smtpUser}>`, to: recipient, subject, text, html, resendFrom: process.env.FEEDBACK_FROM || 'FileCorner Reviews <onboarding@resend.dev>' });
}

module.exports = {
  sendFeedbackEmail,
  ALLOWED_CATEGORIES,
  checkContactRateLimit,
  validateSubmission,
  sendContactEmail,
  getTransporter,
  mailConfig,
  setSenderForTests,
  generateReferenceId
};
