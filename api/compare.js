const https = require('https');
const http = require('http');
const { URL } = require('url');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let { url1, url2 } = req.query;
  if (!url1 || !url2) return res.status(400).json({ error: 'Two URLs required.' });
  if (!/^https?:\/\//i.test(url1)) url1 = 'https://' + url1;
  if (!/^https?:\/\//i.test(url2)) url2 = 'https://' + url2;

  try {
    const [r1, r2] = await Promise.all([fetchAndScore(url1), fetchAndScore(url2)]);
    res.status(200).json({ site1: r1, site2: r2 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};

async function fetchAndScore(url) {
  try {
    const { html, isHttps, status } = await fetchURL(url);
    const p = parseHTML(html);
    const scores = {
      title: p.title && p.titleLen >= 10 && p.titleLen <= 70 ? 100 : p.title ? 50 : 0,
      metaDesc: p.metaDesc && p.metaDescLen >= 50 && p.metaDescLen <= 160 ? 100 : p.metaDesc ? 50 : 0,
      h1: p.h1s.length === 1 ? 100 : p.h1s.length > 1 ? 60 : 0,
      https: isHttps ? 100 : 0,
      canonical: p.canonical ? 100 : 0,
      viewport: p.viewport ? 100 : 0,
      ogTags: p.ogTitle ? 100 : 0,
      images: p.imgTotal === 0 ? 100 : p.imgsWithoutAlt === 0 ? 100 : Math.round((p.imgsWithAlt / p.imgTotal) * 100),
      wordCount: p.wordCount >= 300 ? 100 : Math.round((p.wordCount / 300) * 100),
      structuredData: p.hasJsonLd ? 100 : 0,
    };
    const overall = Math.round(Object.values(scores).reduce((a, b) => a + b, 0) / Object.keys(scores).length);
    return { url, overall, scores, meta: p };
  } catch(e) {
    return { url, error: e.message, overall: 0, scores: {}, meta: {} };
  }
}

function fetchURL(urlStr, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(urlStr); } catch(e) { return reject(new Error('Invalid URL')); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEOBot/1.0)', 'Accept': 'text/html' },
      timeout: 12000
    };
    const req = lib.request(options, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http') ? res.headers.location : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        return resolve(fetchURL(next, redirectCount + 1));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8'), isHttps: parsed.protocol === 'https:', status: res.statusCode }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

function parseHTML(raw) {
  const get = (p) => { const m = raw.match(new RegExp(p, 'i')); return m ? (m[1]||'').trim() : null; };
  const getAll = (p) => [...raw.matchAll(new RegExp(p, 'gi'))].map(m => (m[1]||'').trim()).filter(Boolean);
  const title = get('<title[^>]*>([^<]+)<\/title>');
  const metaDesc = get('<meta[^>]*name=["\']description["\'][^>]*content=["\']([^"\']{1,500})["\']') || get('<meta[^>]*content=["\']([^"\']{1,500})["\'][^>]*name=["\']description["\']');
  const h1s = getAll('<h1[^>]*>([^<]+)<\/h1>');
  const imgTags = [...raw.matchAll(/<img([^>]+)>/gi)].map(m => m[1]);
  const textContent = raw.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  const wordCount = textContent.split(/\s+/).filter(w => w.length > 2).length;
  return {
    title, titleLen: title ? title.length : 0,
    metaDesc, metaDescLen: metaDesc ? metaDesc.length : 0,
    h1s, viewport: get('<meta[^>]*name=["\']viewport["\'][^>]*content=["\']([^"\']+)["\']'),
    canonical: get('<link[^>]*rel=["\']canonical["\'][^>]*href=["\']([^"\']+)["\']'),
    ogTitle: get('<meta[^>]*property=["\']og:title["\'][^>]*content=["\']([^"\']+)["\']'),
    hasJsonLd: /<script[^>]*type=["']application\/ld\+json["']/i.test(raw),
    imgTotal: imgTags.length,
    imgsWithAlt: imgTags.filter(t => /alt=["'][^"']+["']/i.test(t)).length,
    imgsWithoutAlt: imgTags.filter(t => !/alt=/i.test(t)).length,
    wordCount,
  };
}
