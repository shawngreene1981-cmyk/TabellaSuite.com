// Email through Resend (resend.com). Needs the RESEND_API_KEY secret and the tabellasuite.com domain verified there.
// Optional settings: MAIL_FROM (default "Tabella <orders@tabellasuite.com>"), OPS_EMAIL (default contact@tabellasuite.com).
// Without a key, emails are skipped and the reason is returned, so nothing else breaks.

export async function sendEmail(env, m) {
  if (!env.RESEND_API_KEY) return { skipped: 'RESEND_API_KEY not set' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM || 'Tabella <orders@tabellasuite.com>', to: [].concat(m.to), bcc: m.bcc ? [].concat(m.bcc) : undefined,
      reply_to: m.replyTo || env.OPS_EMAIL || 'contact@tabellasuite.com', subject: m.subject, html: m.html, text: m.text })
  });
  const d = await res.json().catch(() => ({}));
  return res.ok ? { id: d.id } : { error: (d && d.message) || res.status };
}

export function opsEmail(env) { return env.OPS_EMAIL || 'contact@tabellasuite.com'; }

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fm = n => '$' + Number(n || 0).toFixed(2);
export function emailFrame(title, inner) { return wrap(title, inner); }
function wrap(title, inner) {
  return '<!doctype html><html><body style="margin:0;background:#F4EFE6;font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#231F1A">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">' +
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FBF8F2;border:1px solid #D5CCBA;border-radius:12px">' +
    '<tr><td style="padding:22px 24px 6px;font:600 14px Georgia,serif;letter-spacing:.22em;color:#231F1A">TABELLA</td></tr>' +
    '<tr><td style="padding:4px 24px 0;font:600 26px Georgia,serif">' + esc(title) + '</td></tr>' +
    '<tr><td style="padding:10px 24px 22px">' + inner + '</td></tr>' +
    '<tr><td style="padding:14px 24px;border-top:1px solid #D5CCBA;font-size:13px;color:#6A6259">Questions? Reply to this email or write to contact@tabellasuite.com.</td></tr>' +
    '</table></td></tr></table></body></html>';
}
function rows(list) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0">' + list.map(([a, b, bold]) =>
    '<tr><td style="padding:6px 0;border-bottom:1px solid #E5DDCD' + (bold ? ';font-weight:700' : '') + '">' + a + '</td><td align="right" style="padding:6px 0;border-bottom:1px solid #E5DDCD' + (bold ? ';font-weight:700' : '') + '">' + b + '</td></tr>').join('') + '</table>';
}
function addr(a) { return a ? [a.name, a.street1, a.street2, a.city + ', ' + a.state + ' ' + a.zip].filter(Boolean).map(esc).join('<br>') : ''; }
function addrText(a) { return a ? [a.name, a.street1, a.street2, a.city + ', ' + a.state + ' ' + a.zip].filter(Boolean).join('\n') : ''; }

export function buyerReceipt(o, shopNames) {
  const b = o.breakdown || {}, test = o.test ? '<p style="background:#F6E7B8;padding:8px 10px;border-radius:8px;font-size:14px">Test order. No real money was charged.</p>' : '';
  const lines = o.items.map(i => [esc(i.title) + ' <span style="color:#6A6259">' + esc(i.id) + '</span>', fm(i.price)]);
  if (b.shipping) lines.push(['Shipping, ' + esc(o.shipping && (o.shipping.carrier + ' ' + (o.shipping.service || ''))), fm(b.shipping)]);
  if (b.tax) lines.push(['Sales tax', fm(b.tax)]);
  if (b.cardProcessing) lines.push(['Card processing', fm(b.cardProcessing)]);
  lines.push(['Total charged', fm(b.total), 1]);
  const html = wrap('Thank you for your order', test + '<p>Order <b>' + esc(o.ref) + '</b> from ' + esc(shopNames) + '. Your payment went through.</p>' + rows(lines) +
    '<p style="margin:14px 0 4px"><b>Shipping to</b></p><p style="margin:0">' + addr(o.shipTo) + '</p>' +
    '<p style="margin-top:16px">The shop packs and ships one-of-a-kind pieces by hand. You will get another email with tracking when it ships.</p>');
  const text = (o.test ? 'TEST ORDER. No real money was charged.\n\n' : '') + 'Thank you for your order ' + o.ref + ' from ' + shopNames + '.\n\n' +
    o.items.map(i => i.title + ' (' + i.id + ')  ' + fm(i.price)).join('\n') + '\nShipping  ' + fm(b.shipping) + (b.tax ? '\nSales tax  ' + fm(b.tax) : '') + '\nCard processing  ' + fm(b.cardProcessing) + '\nTotal charged  ' + fm(b.total) +
    '\n\nShipping to:\n' + addrText(o.shipTo) + '\n\nYou will get tracking when it ships.\n\nTabella';
  return { subject: (o.test ? '[Test] ' : '') + 'Your Tabella order ' + o.ref, html, text };
}

export function dealerAlert(o, shopName) {
  const b = o.breakdown || {}, items = (b.items || []);
  const youGet = items.reduce((t, i) => t + (i.dealer || 0), 0);
  const test = o.test ? '<p style="background:#F6E7B8;padding:8px 10px;border-radius:8px;font-size:14px">Test order. No real money moved.</p>' : '';
  const lines = o.items.map(i => [esc(i.title) + ' <span style="color:#6A6259">' + esc(i.id) + '</span>', fm(i.price)]);
  lines.push(['You get after commission', fm(youGet), 1]);
  const html = wrap('You made a sale', test + '<p>' + esc(shopName) + ', a buyer just paid for:</p>' + rows(lines) +
    '<p style="margin:14px 0 4px"><b>Ship to</b></p><p style="margin:0">' + addr(o.shipTo) + '</p>' +
    '<p style="margin:12px 0 0"><b>Service they paid for:</b> ' + esc(o.shipping && (o.shipping.carrier + ' ' + (o.shipping.service || ''))) + ' (' + fm(o.shipping && o.shipping.amount) + ')</p>' +
    '<p style="margin-top:16px">Pack it in the box size listed and ship within 2 business days. Your share goes to your bank through Stripe. Order <b>' + esc(o.ref) + '</b>.</p>' +
    '<p><a href="https://tabellasuite.com/dealer/" style="display:inline-block;background:#9A4A2E;color:#FFF8F0;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Open your shop</a></p>');
  const text = (o.test ? 'TEST ORDER. No real money moved.\n\n' : '') + shopName + ', you made a sale (order ' + o.ref + ').\n\n' + o.items.map(i => i.title + ' (' + i.id + ')  ' + fm(i.price)).join('\n') +
    '\nYou get after commission: ' + fm(youGet) + '\n\nShip to:\n' + addrText(o.shipTo) + '\n\nService paid for: ' + (o.shipping ? o.shipping.carrier + ' ' + (o.shipping.service || '') : '') +
    '\n\nShip within 2 business days. Open your shop: tabellasuite.com/dealer\n\nTabella';
  return { subject: (o.test ? '[Test] ' : '') + 'Sold: ' + o.items.map(i => i.title).join(', ').slice(0, 80), html, text };
}

export function shippedEmail(o, shopName) {
  const l = o.label || {}, test = o.test ? '<p style="background:#F6E7B8;padding:8px 10px;border-radius:8px;font-size:14px">Test order. This is a test label, not a real shipment.</p>' : '';
  const track = l.trackingUrl ? '<p><a href="' + esc(l.trackingUrl) + '" style="display:inline-block;background:#9A4A2E;color:#FFF8F0;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Track your package</a></p>' : '';
  const html = wrap('Your order is on its way', test + '<p>' + esc(shopName) + ' shipped order <b>' + esc(o.ref) + '</b>:</p>' + rows(o.items.map(i => [esc(i.title), fm(i.price)])) +
    '<p><b>' + esc((l.carrier || '') + ' ' + (l.service || '')) + '</b><br>Tracking number: ' + esc(l.tracking || '') + '</p>' + track +
    '<p style="margin:14px 0 4px"><b>Shipping to</b></p><p style="margin:0">' + addr(o.shipTo) + '</p>');
  const text = (o.test ? 'TEST ORDER. Test label only.\n\n' : '') + shopName + ' shipped order ' + o.ref + '.\n\n' + o.items.map(i => i.title).join('\n') +
    '\n\n' + (l.carrier || '') + ' ' + (l.service || '') + '\nTracking number: ' + (l.tracking || '') + (l.trackingUrl ? '\nTrack it: ' + l.trackingUrl : '') + '\n\nTabella';
  return { subject: (o.test ? '[Test] ' : '') + 'Shipped: your Tabella order ' + o.ref, html, text };
}

export function resetEmail(link) {
  return { subject: 'Reset your Tabella password',
    html: wrap('Reset your password', '<p>Someone asked to reset the password for your Tabella shop. If it was you, tap the button. The link works for one hour.</p>' +
      '<p><a href="' + esc(link) + '" style="display:inline-block;background:#9A4A2E;color:#FFF8F0;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Choose a new password</a></p>' +
      '<p style="font-size:14px;color:#6A6259">If you didn’t ask for this, ignore this email. Your password stays the same.</p>'),
    text: 'Reset your Tabella password (link works for one hour):\n' + link + '\n\nIf you did not ask for this, ignore this email.' };
}

// A short plain note in the Tabella email style. Paragraphs are trusted HTML built by the caller (escape user text first).
export function noteEmail(title, paras) { return wrap(title, paras.filter(Boolean).map(p => '<p style="margin:0 0 12px">' + p + '</p>').join('')); }
