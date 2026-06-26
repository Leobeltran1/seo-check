const https = require('https');
const { URL } = require('url');
const { rateLimit, cacheGet, cacheSet } = require('./_guard.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rl = await rateLimit(req, 'keyword', 15, 60);
  if (!rl.ok) { res.setHeader('Retry-After', rl.retryAfter); return res.status(429).json({ error: 'Too many requests — please wait a minute and try again.' }); }

  const { keyword, targetUrl } = req.query;
  const key = process.env.SERPAPI_KEY;

  if (!keyword) return res.status(400).json({ error: 'Keyword is required.' });
  if (!key) return res.status(500).json({ error: 'Search API not configured on server.' });

  const ck = 'kw:' + keyword.toLowerCase() + '|' + (targetUrl || '').toLowerCase();
  const hit = await cacheGet(ck);
  if (hit) return res.status(200).json(Object.assign(hit, { cached: true }));

  try {
    const data = await fetchSERP(keyword, key);
    let targetDomain = null;
    let targetRank   = null;

    if (targetUrl) {
      try {
        const parsed = new URL(targetUrl.startsWith('http') ? targetUrl : 'https://' + targetUrl);
        targetDomain = parsed.hostname.replace(/^www\./, '');
        const items = data.organic_results || [];
        for (let i = 0; i < items.length; i++) {
          try {
            const itemDomain = new URL(items[i].link).hostname.replace(/^www\./, '');
            if (itemDomain === targetDomain) { targetRank = i + 1; break; }
          } catch(e) {}
        }
      } catch(e) {}
    }

    const items = (data.organic_results || []).slice(0, 10).map((item, i) => ({
      rank:        i + 1,
      title:       item.title,
      link:        item.link,
      displayLink: new URL(item.link).hostname.replace(/^www\./, ''),
      snippet:     item.snippet || '',
    }));

    const result = {
      keyword,
      totalResults: data.search_information?.total_results,
      searchTime:   data.search_information?.time_taken_displayed,
      items,
      targetDomain,
      targetRank,
    };
    await cacheSet(ck, result, 21600); // 6h
    res.status(200).json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};

function fetchSERP(keyword, key) {
  return new Promise((resolve, reject) => {
    const searchUrl = `https://serpapi.com/search.json?q=${encodeURIComponent(keyword)}&api_key=${encodeURIComponent(key)}&num=10&engine=google`;
    const parsed = new URL(searchUrl);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  { 'Accept': 'application/json' },
      timeout:  15000,
    };
    const req = https.request(options, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (data.error) return reject(new Error(data.error));
          resolve(data);
        } catch(e) {
          reject(new Error('Failed to parse search results'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Search request timed out')); });
    req.end();
  });
}
