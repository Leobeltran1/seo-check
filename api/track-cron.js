/*
 * Daily rank-refresh job for tracked keywords.
 *
 * NOT scheduled by default — each run calls SerpAPI once per tracked keyword,
 * which costs money. To enable: set SUPABASE_SERVICE_KEY (Supabase service-role
 * key) in Vercel env, then add to vercel.json "crons":
 *   { "path": "/api/track-cron", "schedule": "0 9 * * *" }
 * Until SUPABASE_SERVICE_KEY is set, this endpoint no-ops safely.
 *
 * Uses the service-role key to read every user's tracked_keywords and write
 * rank_history (bypassing RLS), then updates last_position/last_checked_at.
 */
const https = require('https');

const SUPA_URL = 'https://jjfojqvhcecyxmstpmxl.supabase.co';
const MAX_PER_RUN = 100;     // bound cost + duration
const CONCURRENCY = 4;

module.exports = async function handler(req, res) {
  const svc = process.env.SUPABASE_SERVICE_KEY;
  const serp = process.env.SERPAPI_KEY;
  if (!svc) return res.status(200).json({ ok: false, skipped: 'SUPABASE_SERVICE_KEY not set — automated rank tracking is disabled.' });
  if (!serp) return res.status(200).json({ ok: false, skipped: 'SERPAPI_KEY not set.' });

  try {
    const tracked = await supa('GET', 'tracked_keywords?select=id,user_id,keyword,domain&order=last_checked_at.asc.nullsfirst&limit=' + MAX_PER_RUN, svc);
    let checked = 0, updated = 0;
    for (let i = 0; i < tracked.length; i += CONCURRENCY) {
      const batch = tracked.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (t) => {
        checked++;
        let position = null;
        try { position = await serpPosition(t.keyword, t.domain, serp); } catch (e) { return; }
        try {
          await supa('POST', 'rank_history', svc, { tracked_keyword_id: t.id, user_id: t.user_id, position });
          await supa('PATCH', 'tracked_keywords?id=eq.' + t.id, svc, { last_position: position, last_checked_at: new Date().toISOString() });
          updated++;
        } catch (e) {}
      }));
    }
    res.status(200).json({ ok: true, checked, updated, at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};

function supa(method, path, key, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPA_URL + '/rest/v1/' + path);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: {
        apikey: key, Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        Prefer: method === 'GET' ? '' : 'return=minimal',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }, timeout: 15000
    }, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (r.statusCode >= 400) return reject(new Error('Supabase ' + r.statusCode + ': ' + txt));
        try { resolve(txt ? JSON.parse(txt) : null); } catch (e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Supabase timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

function serpPosition(keyword, domain, key) {
  return new Promise((resolve, reject) => {
    const u = new URL('https://serpapi.com/search.json?q=' + encodeURIComponent(keyword) + '&api_key=' + encodeURIComponent(key) + '&num=10&engine=google');
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { Accept: 'application/json' }, timeout: 15000 }, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (data.error) return reject(new Error(data.error));
          const target = domain.replace(/^www\./, '');
          const items = data.organic_results || [];
          for (let i = 0; i < items.length; i++) {
            try { if (new URL(items[i].link).hostname.replace(/^www\./, '') === target) return resolve(i + 1); } catch (e) {}
          }
          resolve(null);
        } catch (e) { reject(new Error('SERP parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('SERP timeout')); });
    req.end();
  });
}
