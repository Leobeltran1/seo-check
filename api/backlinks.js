const https = require('https');
const { URL } = require('url');
const { rateLimit } = require('./_guard.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rl = await rateLimit(req, 'backlinks', 20, 60);
  if (!rl.ok) { res.setHeader('Retry-After', rl.retryAfter); return res.status(429).json({ error: 'Too many requests — please wait a minute and try again.' }); }

  let { url } = req.query;
  const key = process.env.OPENPAGERANK_KEY;

  if (!url) return res.status(400).json({ error: 'URL is required.' });
  if (!key) return res.status(500).json({ error: 'Backlink API not configured on server.' });

  try {
    let domain = url;
    try {
      if (!url.startsWith('http')) url = 'https://' + url;
      domain = new URL(url).hostname.replace(/^www\./, '');
    } catch(e) {}

    const data = await fetchPageRank(domain, key);
    const result = data.response && data.response[0];

    if (!result) return res.status(404).json({ error: 'No data found for this domain.' });

    res.status(200).json({
      domain,
      pageRank: result.page_rank_decimal || 0,
      pageRankInt: result.page_rank_integer || 0,
      rank: result.rank || 'N/A',
      status: result.status_code || 200,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};

function fetchPageRank(domain, key) {
  return new Promise((resolve, reject) => {
    const path = `/api/v1.0/getPageRank?domains[]=${encodeURIComponent(domain)}`;
    const options = {
      hostname: 'openpagerank.com',
      path,
      method: 'GET',
      headers: {
        'API-OPR': key,
        'Accept': 'application/json'
      },
      timeout: 10000,
    };
    const req = https.request(options, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(data);
        } catch(e) { reject(new Error('Failed to parse response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}
