const https = require('https');
const { URL } = require('url');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { keyword, targetUrl } = req.query;
  const key = process.env.GOOGLE_API_KEY;
  const cx  = process.env.GOOGLE_CX;

  if (!keyword) return res.status(400).json({ error: 'Keyword is required.' });
  if (!key || !cx) return res.status(500).json({ error: 'Search API not configured on server.' });

  try {
    const data = await fetchSERP(keyword, key, cx);
    let targetDomain = null;
    let targetRank   = null;
    if (targetUrl) {
      try {
        const parsed = new URL(targetUrl.startsWith('http') ? targetUrl : 'https://' + targetUrl);
        targetDomain = parsed.hostname.replace(/^www\./, '');
        const items = data.items || [];
        for (let i = 0; i < items.length; i++) {
          try {
            const itemDomain = new URL(items[i].link).hostname.replace(/^www\./, '');
            if (itemDomain === targetDomain) { targetRank = i + 1; break; }
          } catch(e) {}
        }
      } catch(e) {}
    }
    res.status(200).json({
      keyword,
      totalResults: data.searchInformation?.totalResults,
      searchTime:   data.searchInformation?.formattedSearchTime,
      items: (data.items || []).slice(0, 10).map((item, i) => ({
        rank:        i + 1,
        title:       item.title,
        link:        item.link,
        displayLink: item.displayLink,
        snippet:     item.snippet || '',
      })),
      targetDomain,
      targetRank,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};

function fetchSERP(keyword, key, cx) {
  return new Promise((resolve, reject) => {
    const searchUrl = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(keyword)}&key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&num=10`;
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
          if (data.error) return reject(new Error(data.error.message || 'Google API error'));
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
