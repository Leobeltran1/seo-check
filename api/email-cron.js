/*
 * Weekly email digest + rank-drop alerts for SEO Rocket.
 *
 * NOT scheduled by default. To enable:
 *   1. Set RESEND_API_KEY and SUPABASE_SERVICE_KEY in Vercel env.
 *   2. Set EMAIL_FROM (e.g. "SEO Rocket <reports@seo-rocket.ai>") on a domain
 *      verified in Resend.
 *   3. Add to vercel.json crons: { "path": "/api/email-cron", "schedule": "0 13 * * 1" }
 *
 * Modes:
 *   GET /api/email-cron?dry=1   → render a SAMPLE digest as HTML (no keys, no send)
 *   GET /api/email-cron         → real run: emails opted-in users with activity
 */
const https = require('https');

const SUPA_URL = 'https://jjfojqvhcecyxmstpmxl.supabase.co';

module.exports = async function handler(req, res) {
  // Dry-run preview with sample data — lets you see the template with no setup.
  if (req.query.dry) {
    const html = renderDigest('there', sampleData());
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).end(html.html);
  }

  const RESEND = process.env.RESEND_API_KEY;
  const SVC = process.env.SUPABASE_SERVICE_KEY;
  const FROM = process.env.EMAIL_FROM || 'SEO Rocket <onboarding@resend.dev>';
  if (!RESEND) return res.status(200).json({ ok: false, skipped: 'RESEND_API_KEY not set — email reports disabled.' });
  if (!SVC) return res.status(200).json({ ok: false, skipped: 'SUPABASE_SERVICE_KEY not set.' });

  try {
    const users = await supa('GET', 'profiles?select=id,email,email_reports&email_reports=eq.true', SVC);
    let sent = 0, skipped = 0;
    for (const u of users) {
      if (!u.email) { skipped++; continue; }
      const tracked = await supa('GET', 'tracked_keywords?select=id,keyword,domain,last_position&user_id=eq.' + u.id, SVC);
      const history = await supa('GET', 'rank_history?select=tracked_keyword_id,position,checked_at&user_id=eq.' + u.id + '&order=checked_at.desc&limit=300', SVC);
      const audits = await supa('GET', 'audits?select=url,overall_score,created_at&user_id=eq.' + u.id + '&order=created_at.desc&limit=5', SVC);
      const data = assemble(tracked, history, audits);
      if (!data.hasContent) { skipped++; continue; }
      const digest = renderDigest((u.email.split('@')[0]) || 'there', data);
      await sendResend(FROM, u.email, digest.subject, digest.html, RESEND);
      await supa('PATCH', 'profiles?id=eq.' + u.id, SVC, { last_digest_at: new Date().toISOString() });
      sent++;
    }
    res.status(200).json({ ok: true, sent, skipped, at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};

// Build per-user digest data: rank changes + recent audits.
function assemble(tracked, history, audits) {
  const byTk = {};
  for (const h of history) (byTk[h.tracked_keyword_id] = byTk[h.tracked_keyword_id] || []).push(h);
  const rows = (tracked || []).map(t => {
    const hist = (byTk[t.id] || []); // newest first
    const cur = t.last_position;
    const prev = hist.length > 1 ? hist[1].position : null;
    let change = null;
    if (cur != null && prev != null) change = prev - cur; // positive = improved (smaller rank)
    return { keyword: t.keyword, domain: t.domain, position: cur, change };
  });
  const drops = rows.filter(r => r.change != null && r.change < 0);
  return {
    rows,
    drops,
    audits: (audits || []).map(a => ({ url: a.url, score: a.overall_score })),
    hasContent: rows.length > 0 || (audits || []).length > 0
  };
}

function fmtPos(p) { return p == null ? 'Not in top 10' : '#' + p; }
function changeBadge(c) {
  if (c == null) return '<span style="color:#94a3b8;">—</span>';
  if (c > 0) return '<span style="color:#10b981;font-weight:700;">▲ ' + c + '</span>';
  if (c < 0) return '<span style="color:#ef4444;font-weight:700;">▼ ' + Math.abs(c) + '</span>';
  return '<span style="color:#94a3b8;">no change</span>';
}

function renderDigest(name, data) {
  const dropCount = data.drops.length;
  const subject = dropCount
    ? `⚠ ${dropCount} keyword${dropCount > 1 ? 's' : ''} dropped — your SEO Rocket weekly report`
    : 'Your SEO Rocket weekly report';

  let rankRows = data.rows.map(r => `
    <tr>
      <td style="padding:10px 8px;border-bottom:1px solid #eef0f4;font-weight:600;color:#0B0E1A;">${esc(r.keyword)}<div style="font-size:12px;color:#94a3b8;font-weight:400;">${esc(r.domain)}</div></td>
      <td style="padding:10px 8px;border-bottom:1px solid #eef0f4;text-align:center;font-weight:700;color:#0B0E1A;">${fmtPos(r.position)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eef0f4;text-align:center;">${changeBadge(r.change)}</td>
    </tr>`).join('');
  if (!data.rows.length) rankRows = '<tr><td colspan="3" style="padding:14px 8px;color:#94a3b8;">No keywords tracked yet.</td></tr>';

  const auditsBlock = data.audits.length ? `
    <h3 style="font-size:15px;color:#0B0E1A;margin:28px 0 10px;">Recent audits</h3>
    ${data.audits.map(a => `<div style="padding:8px 0;border-bottom:1px solid #eef0f4;font-size:14px;color:#334155;">${esc(domainOf(a.url))} <span style="float:right;font-weight:700;color:${a.score >= 75 ? '#10b981' : a.score >= 50 ? '#f59e0b' : '#0B0E1A'};">${a.score == null ? '—' : a.score + '%'}</span></div>`).join('')}` : '';

  const dropBanner = dropCount ? `
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px 16px;margin-bottom:20px;color:#991b1b;font-size:14px;">
      <b>${dropCount} keyword${dropCount > 1 ? 's' : ''} dropped in ranking this week.</b> See the ▼ rows below.
    </div>` : '';

  const html = `<!DOCTYPE html><html><body style="margin:0;background:#f4f6fb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <div style="background:#0B0E1A;border-radius:14px 14px 0 0;padding:22px 26px;">
      <span style="font-size:20px;font-weight:900;color:#fff;">🚀 SEO <span style="color:#C0F040;">Rocket</span></span>
    </div>
    <div style="background:#fff;border:1px solid #e6e9f0;border-top:none;border-radius:0 0 14px 14px;padding:26px;">
      <h2 style="font-size:20px;color:#0B0E1A;margin:0 0 6px;">Hi ${esc(name)}, here's your week 👋</h2>
      <p style="color:#64748b;font-size:14px;margin:0 0 20px;">Your tracked keywords and recent activity on SEO Rocket.</p>
      ${dropBanner}
      <h3 style="font-size:15px;color:#0B0E1A;margin:0 0 8px;">Keyword rankings</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr style="color:#94a3b8;font-size:12px;text-transform:uppercase;"><th style="text-align:left;padding:6px 8px;">Keyword</th><th style="padding:6px 8px;">Position</th><th style="padding:6px 8px;">Change</th></tr>
        ${rankRows}
      </table>
      ${auditsBlock}
      <div style="text-align:center;margin:28px 0 6px;">
        <a href="https://seo-check-flax.vercel.app/dashboard.html" style="display:inline-block;background:#C0F040;color:#0B0E1A;font-weight:700;text-decoration:none;padding:13px 30px;border-radius:10px;font-size:15px;">Open your dashboard →</a>
      </div>
    </div>
    <p style="text-align:center;color:#94a3b8;font-size:12px;margin:16px 0;">You're getting this because email reports are on. Manage them in your <a href="https://seo-check-flax.vercel.app/profile.html" style="color:#64748b;">profile</a>.</p>
  </div></body></html>`;

  return { subject, html };
}

function sampleData() {
  return {
    rows: [
      { keyword: 'fiber optic cabling miami', domain: 'fiberopticcablingmiami.com', position: 4, change: 2 },
      { keyword: 'network cabling orlando', domain: 'networkcablingorlando.com', position: 9, change: -3 },
      { keyword: 'structured cabling tampa', domain: 'structuredcablingtampa.net', position: null, change: null }
    ],
    drops: [{ keyword: 'network cabling orlando', change: -3 }],
    audits: [{ url: 'https://titancabling.com', score: 67 }, { url: 'https://fiberopticcablingmiami.com', score: 81 }],
    hasContent: true
  };
}

function domainOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function sendResend(from, to, subject, html, key) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ from, to, subject, html });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000
    }, (r) => { const c = []; r.on('data', x => c.push(x)); r.on('end', () => r.statusCode < 300 ? resolve(true) : reject(new Error('Resend ' + r.statusCode + ': ' + Buffer.concat(c).toString()))); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Resend timeout')); });
    req.write(body); req.end();
  });
}

function supa(method, path, key, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPA_URL + '/rest/v1/' + path);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: method === 'GET' ? '' : 'return=minimal', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
      timeout: 15000
    }, (r) => { const c = []; r.on('data', x => c.push(x)); r.on('end', () => { const t = Buffer.concat(c).toString(); if (r.statusCode >= 400) return reject(new Error('Supabase ' + r.statusCode + ': ' + t)); try { resolve(t ? JSON.parse(t) : null); } catch (e) { resolve(null); } }); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Supabase timeout')); });
    if (data) req.write(data); req.end();
  });
}
