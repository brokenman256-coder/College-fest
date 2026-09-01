// OTP email delivery. Two providers, tried in order:
// 1. Gmail SMTP (free, delivers to EVERYONE) — set GMAIL_USER + GMAIL_APP_PASSWORD
//    (Google Account → Security → 2-Step Verification ON → App passwords → Mail)
// 2. Resend API — set RESEND_API_KEY (+ EMAIL_FROM). Without a verified domain,
//    Resend only delivers to the account owner's own email.
// If neither can deliver, the caller falls back to demo mode (code on screen).

const nodemailer = require('nodemailer');

const RESEND_FROM = process.env.EMAIL_FROM || 'College Fest <onboarding@resend.dev>';

function gmailConfigured() {
  return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}
function resendConfigured() {
  return !!process.env.RESEND_API_KEY;
}
function isConfigured() {
  return gmailConfigured() || resendConfigured();
}

function otpEmailHtml(code, minutes) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#05060f;font-family:Segoe UI,Arial,sans-serif;">
  <div style="max-width:480px;margin:24px auto;background:#0d1024;border:1px solid #1e2450;border-radius:14px;padding:28px;text-align:center;">
    <h1 style="margin:0 0 6px;font-size:22px;letter-spacing:2px;color:#00f0ff;text-transform:uppercase;">College Fest</h1>
    <p style="margin:0 0 20px;color:#8b93c7;font-size:13px;">Campus experience board · sign-in code</p>
    <div style="display:inline-block;background:rgba(0,240,255,.08);border:1px solid #00f0ff;border-radius:10px;padding:14px 26px;margin-bottom:18px;">
      <span style="font-size:34px;font-weight:700;letter-spacing:8px;color:#00f0ff;font-family:Consolas,monospace;">${code}</span>
    </div>
    <p style="margin:0 0 6px;color:#e8f6ff;font-size:14px;">This code expires in <b>${minutes} minutes</b>.</p>
    <p style="margin:0;color:#8b93c7;font-size:12px;">Didn't request it? Ignore this email — nothing changes.</p>
    <hr style="border:none;border-top:1px solid #1e2450;margin:20px 0;">
    <p style="margin:0;color:#5a6188;font-size:11px;">Anonymous to other students. The desk can identify accounts only for moderation.</p>
  </div>
</body>
</html>`;
}

async function sendViaGmail(to, code, minutes) {
  try {
    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });
    await transport.sendMail({
      from: 'College Fest <' + process.env.GMAIL_USER + '>',
      to,
      subject: 'Your College Fest login code: ' + code,
      html: otpEmailHtml(code, minutes)
    });
    return { sent: true, via: 'gmail' };
  } catch (e) {
    console.error('OTP gmail error:', e.message);
    return { sent: false, reason: 'send_failed' };
  }
}

async function sendViaResend(to, code, minutes) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + process.env.RESEND_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [to],
        subject: 'Your College Fest login code: ' + code,
        html: otpEmailHtml(code, minutes)
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('OTP email failed:', res.status, body.slice(0, 300));
      return { sent: false, reason: 'send_failed' };
    }
    return { sent: true, via: 'resend' };
  } catch (e) {
    console.error('OTP email error:', e.message);
    return { sent: false, reason: 'network_error' };
  }
}

// Try Gmail first (delivers to everyone for free), then Resend.
async function sendOTPEmail(to, code, minutes = 10) {
  if (gmailConfigured()) {
    const r = await sendViaGmail(to, code, minutes);
    if (r.sent) return r;
  }
  if (resendConfigured()) {
    const r = await sendViaResend(to, code, minutes);
    if (r.sent) return r;
  }
  return { sent: false, reason: 'no_provider_could_deliver' };
}

module.exports = { isConfigured, sendOTPEmail };