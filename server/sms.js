// OTP SMS delivery via Twilio REST API — plain fetch, no SDK.
// Set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM_NUMBER in .env to enable.
// Without them, phone logins fall back to demo mode (OTP shown on screen).

function isConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
}

// 10-digit numbers get the default country prefix (default 91 = India);
// longer numbers are assumed to already include the country code.
function toE164(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return '+' + (process.env.TWILIO_DEFAULT_COUNTRY || '91') + digits;
  return '+' + digits;
}

async function sendOTPSms(to, code, minutes = 10) {
  if (!isConfigured()) return { sent: false, reason: 'not_configured' };
  const sid = process.env.TWILIO_ACCOUNT_SID;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + Buffer.from(sid + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'),
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        From: process.env.TWILIO_FROM_NUMBER,
        To: toE164(to),
        Body: `College Fest login code: ${code}. Expires in ${minutes} minutes. Do not share this code.`
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('OTP SMS failed:', res.status, body.slice(0, 300));
      return { sent: false, reason: 'send_failed' };
    }
    return { sent: true };
  } catch (e) {
    console.error('OTP SMS error:', e.message);
    return { sent: false, reason: 'network_error' };
  }
}

module.exports = { isConfigured, sendOTPSms, toE164 };