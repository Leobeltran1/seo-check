/*
 * Schema / FAQ generator. Fetches a page and produces ready-to-paste JSON-LD:
 *   - FAQPage   (from question-style headings + the text that follows them)
 *   - Article   (from title/description/author/dates/image)
 *   - Organization / WebSite (from site name, url, logo)
 * Pure heuristics, no external API keys.
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { rateLimit, validatePublicUrl } = require('./_guard.js');

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rl = await rateLimit(req, 'schema', 20, 60);
  if (!rl.ok) { res.setHeader('Retry-After', rl.retryAfter); return res.status(429).json({ error: 'Too many requests — please wait a minute and try again.' }); }

  let url;
  try { url = await validatePublicUrl(req.query.url); }
  catch (e) { return res.status(e.code === 'SSRF' ? 403 : 400).json({ error: e.message }); }

  try {
    const page = await fetchURL(url);
    if (!page.html || page.status >= 400) {
      return res.status(502).json({ error: 'Could not fetch the page (status ' + page.status + ').' });
    }
    res.status(200).json(build(page));
  } catch (e) {
    res.status(500).json({ error: e.message || 'Generation failed.' });
  }
};

function build(page) {
  const html = page.html;
  const finalUrl = page.finalUrl;
  const meta = extractMeta(html, finalUrl);
  const faqs = extractFaqs(html);
  const existing = /application\/ld\+json/i.test(html);

  const schemas = {};

  if (faqs.length) {
    schemas.faq = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqs.map(f => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a }
      }))
    };
  }

  schemas.article = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: meta.title || '',
    description: meta.description || '',
    image: meta.image ? [meta.image] : undefined,
    author: meta.author ? { '@type': 'Person', name: meta.author } : undefined,
    datePublished: meta.datePublished || undefined,
    dateModified: meta.dateModified || meta.datePublished || undefined,
    mainEntityOfPage: { '@type': 'WebPage', '@id': finalUrl },
    publisher: meta.siteName ? {
      '@type': 'Organization',
      name: meta.siteName,
      logo: meta.logo ? { '@type': 'ImageObject', url: meta.logo } : undefined
    } : undefined
  };

  schemas.organization = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: meta.siteName || meta.title || '',
    url: meta.origin,
    logo: meta.logo || undefined,
    sameAs: meta.sameAs.length ? meta.sameAs : undefined
  };

  // prune undefined for clean output
  const clean = o => JSON.parse(JSON.stringify(o));
  const out = {};
  for (const k of Object.keys(schemas)) out[k] = wrap(clean(schemas[k]));

  return {
    url: finalUrl,
    hasExistingSchema: existing,
    faqCount: faqs.length,
    detected: { title: meta.title, siteName: meta.siteName, author: meta.author, datePublished: meta.datePublished },
    schemas: out,
    meta: { generatedAt: new Date().toISOString() }
  };
}

function wrap(obj) {
  return '<script type="application/ld+json">\n' + JSON.stringify(obj, null, 2) + '\n</script>';
}

// ── extraction ──────────────────────────────────────────────
function extractMeta(html, url) {
  const m = (re) => { const x = html.match(re); return x ? decode(x[1].trim()) : null; };
  const origin = (() => { try { return new URL(url).origin; } catch (e) { return url; } })();
  const title = m(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    m(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = m(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
    m(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);
  const image = m(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  const siteName = m(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  const author = m(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i) ||
    m(/rel=["']author["'][^>]*>([^<]+)</i);
  const datePublished = m(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i) ||
    m(/<time[^>]+datetime=["']([^"']+)["']/i);
  const dateModified = m(/<meta[^>]+property=["']article:modified_time["'][^>]+content=["']([^"']+)["']/i);
  // logo guess: apple-touch-icon or first icon
  const logo = (() => {
    const i = html.match(/<link[^>]+rel=["'][^"']*(?:apple-touch-icon|icon)[^"']*["'][^>]+href=["']([^"']+)["']/i);
    if (!i) return null;
    try { return new URL(i[1], origin).href; } catch (e) { return null; }
  })();
  const sameAs = [...html.matchAll(/href=["'](https?:\/\/(?:www\.)?(?:twitter|x|facebook|linkedin|instagram|youtube)\.com\/[^"']+)["']/gi)]
    .map(x => x[1]); const sameAsU = [...new Set(sameAs)].slice(0, 6);
  return { origin, title, description, image, siteName, author, datePublished, dateModified, logo, sameAs: sameAsU };
}

function extractFaqs(html) {
  // collect headings with positions
  const heads = [...html.matchAll(/<h([2-4])[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map(m => ({ level: +m[1], text: stripTags(m[2]).trim(), end: m.index + m[0].length, start: m.index }));
  const faqs = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    if (!isQuestion(h.text)) continue;
    const next = heads[i + 1];
    const slice = html.slice(h.end, next ? next.start : h.end + 2000);
    // Prefer the paragraph text between headings (skips nav/lists of links);
    // fall back to all text if there are no <p> blocks.
    const paras = [...slice.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map(m => stripTags(m[1])).filter(t => t.length > 25);
    let answer = (paras.length ? paras.join(' ') : stripTags(slice)).replace(/\s+/g, ' ').trim().slice(0, 600);
    if (answer.length >= 30) faqs.push({ q: h.text, a: answer });
    if (faqs.length >= 12) break;
  }
  return faqs;
}
function isQuestion(t) {
  if (!t) return false;
  if (/\?\s*$/.test(t)) return true;
  return /^(how|what|why|when|where|who|which|can|is|are|do|does|should|will|did|has|have)\b/i.test(t) && t.length < 120;
}
function stripTags(s) {
  return decode((s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
}
function decode(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

// ── fetch (SSRF-validated upstream) ─────────────────────────
function fetchURL(urlStr, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { return reject(new Error('Invalid URL')); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname, path: parsed.pathname + parsed.search,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEORocketSchema/1.0)', 'Accept': 'text/html' },
      timeout: 12000
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http') ? res.headers.location
          : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        return resolve(fetchURL(next, redirectCount + 1));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8'), finalUrl: urlStr, status: res.statusCode }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

module.exports = handler;
module.exports._test = { build };
