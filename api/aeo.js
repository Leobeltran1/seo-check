/*
 * Answer Engine Optimization (AEO) readiness analyzer.
 * Fetches a page (plus its robots.txt and llms.txt) and scores how well it's
 * set up to be surfaced/cited by AI answer engines (ChatGPT, Perplexity,
 * Gemini, Google AI Overviews, etc.). No external API keys required.
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required.' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  let origin;
  try { origin = new URL(url).origin; } catch (e) { return res.status(400).json({ error: 'Invalid URL.' }); }

  try {
    const page = await fetchURL(url);
    if (!page.html || page.status >= 400) {
      return res.status(502).json({ error: 'Could not fetch the page (status ' + page.status + ').' });
    }
    const robots = await fetchText(origin + '/robots.txt').catch(() => null);
    const llms = await fetchText(origin + '/llms.txt').catch(() => null);

    const report = analyze(page, robots, llms);
    report.url = page.finalUrl || url;
    report.meta = { analyzedAt: new Date().toISOString() };
    res.status(200).json(report);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Analysis failed.' });
  }
};

// ── analysis ────────────────────────────────────────────────
function analyze(page, robotsTxt, llmsTxt) {
  const html = page.html;
  const lower = html.toLowerCase();
  const text = stripTags(html);
  const words = (text.match(/\b\w+\b/g) || []).length;

  // JSON-LD blocks
  const ldBlocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1]);
  const ldTypes = new Set();
  for (const b of ldBlocks) {
    for (const m of b.matchAll(/"@type"\s*:\s*"([^"]+)"/g)) ldTypes.add(m[1].toLowerCase());
  }
  const has = (...types) => types.some(t => ldTypes.has(t.toLowerCase()));

  // Headings
  const headings = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map(m => ({ level: +m[1], text: stripTags(m[2]).trim() }));
  const h1s = headings.filter(h => h.level === 1);
  const questionHeadings = headings.filter(h => /\?\s*$/.test(h.text) ||
    /^(how|what|why|when|where|who|which|can|is|are|do|does|should)\b/i.test(h.text));

  const lists = (lower.match(/<(ul|ol)[\b>]/g) || []).length;
  const tables = (lower.match(/<table[\b>]/g) || []).length;

  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const metaDesc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1];
  const ogCount = (lower.match(/<meta[^>]+property=["']og:/g) || []).length;
  const canonical = /<link[^>]+rel=["']canonical["']/i.test(html);

  // Authority signals
  const hasAuthor = has('person') || /rel=["']author["']|class=["'][^"']*author/i.test(html) || /"author"\s*:/.test(html);
  const hasDates = /datepublished|datemodified|datetime=|"datePublished"/i.test(html) ||
    /<time[\b>]/i.test(lower);
  const outboundCitations = countOutbound(html, page.finalUrl);

  // AI crawler access from robots.txt
  const aiBots = ['gptbot', 'oai-searchbot', 'chatgpt-user', 'claudebot', 'anthropic-ai', 'perplexitybot',
    'google-extended', 'ccbot', 'bytespider', 'amazonbot', 'cohere-ai'];
  let blockedBots = [];
  if (robotsTxt) {
    const rl = robotsTxt.toLowerCase();
    const groups = rl.split(/user-agent:/).slice(1);
    for (const bot of aiBots) {
      for (const g of groups) {
        const head = g.split('\n')[0].trim();
        if ((head === bot || head === '*') && /disallow:\s*\/\s*(\n|$)/.test(g)) {
          if (head === bot) blockedBots.push(bot);
        }
      }
    }
  }
  const hasLlmsTxt = !!(llmsTxt && llmsTxt.trim().length);

  // ── per-category checks ──
  const C = {};

  C.structuredData = [
    chk(ldBlocks.length > 0, 'JSON-LD structured data present', 'high',
      ldBlocks.length ? ldBlocks.length + ' block(s) found' : 'No JSON-LD found — AI engines rely on it to understand your content'),
    chk(has('faqpage', 'qapage'), 'FAQ / Q&A schema', 'high',
      has('faqpage', 'qapage') ? 'FAQ/QA schema found' : 'Add FAQPage schema — directly feeds AI answer boxes'),
    chk(has('article', 'blogposting', 'newsarticle'), 'Article schema', 'medium',
      has('article', 'blogposting', 'newsarticle') ? 'Article schema found' : 'Add Article/BlogPosting schema for content pages'),
    chk(has('organization', 'website', 'webpage'), 'Organization / site schema', 'medium',
      has('organization', 'website', 'webpage') ? 'Site/Org schema found' : 'Add Organization schema to define your entity'),
    chk(has('howto', 'breadcrumblist', 'product', 'recipe'), 'Rich content schema (HowTo / Product / etc.)', 'low',
      'Optional schema types that help specific answer formats')
  ];

  C.answerContent = [
    chk(questionHeadings.length >= 2, 'Question-style headings', 'high',
      questionHeadings.length + ' question-style heading(s) — AI engines extract Q&A pairs'),
    chk(/<(ul|ol)[\b>]/.test(lower) && lists >= 1, 'Uses lists', 'medium',
      lists + ' list(s) — bullet/numbered lists are easy for AI to quote'),
    chk(tables >= 1, 'Uses tables', 'low',
      tables ? tables + ' table(s) found' : 'Tables help AI extract structured comparisons'),
    chk(words >= 300, 'Substantive content', 'medium',
      words + ' words' + (words < 300 ? ' — thin content is rarely cited' : '')),
    chk(hasConciseAnswer(text), 'Concise answer near the top', 'medium',
      'A clear 2–3 sentence summary up top improves citation odds')
  ];

  C.structure = [
    chk(h1s.length === 1, 'Exactly one H1', 'medium',
      h1s.length === 1 ? 'Single H1 found' : (h1s.length + ' H1 tags — use exactly one clear topic heading')),
    chk(headings.filter(h => h.level === 2).length >= 2, 'Clear H2 sections', 'medium',
      headings.filter(h => h.level === 2).length + ' H2 section(s)'),
    chk(headings.length >= 3, 'Logical heading outline', 'low',
      headings.length + ' headings total'),
    chk(!!title && title.trim().length > 0, 'Page title', 'medium',
      title ? 'Title: "' + title.trim().slice(0, 60) + '"' : 'Missing <title>')
  ];

  C.crawlerAccess = [
    chk(!!robotsTxt, 'robots.txt reachable', 'low',
      robotsTxt ? 'robots.txt found' : 'No robots.txt found (not required, but recommended)'),
    chk(blockedBots.length === 0, 'AI crawlers allowed', 'high',
      blockedBots.length ? 'Blocked: ' + blockedBots.join(', ') + ' — these engines cannot read your page' : 'No AI crawlers are blocked'),
    chk(hasLlmsTxt, 'llms.txt present', 'low',
      hasLlmsTxt ? 'llms.txt found' : 'Optional: add /llms.txt to guide AI crawlers to key content')
  ];

  C.authority = [
    chk(hasAuthor, 'Author / byline', 'medium',
      hasAuthor ? 'Author signal found' : 'Add a visible author + Person schema (E-E-A-T)'),
    chk(hasDates, 'Published / updated dates', 'medium',
      hasDates ? 'Date signal found' : 'Add visible published/updated dates — AI favors fresh content'),
    chk(outboundCitations >= 1, 'Cites external sources', 'low',
      outboundCitations + ' outbound reference link(s)')
  ];

  C.metadata = [
    chk(!!metaDesc && metaDesc.length >= 50, 'Meta description', 'medium',
      metaDesc ? metaDesc.length + ' chars' : 'Missing meta description'),
    chk(ogCount >= 2, 'Open Graph tags', 'low',
      ogCount + ' OG tag(s)'),
    chk(canonical, 'Canonical URL', 'low',
      canonical ? 'Canonical set' : 'Add a canonical link'),
    chk(!!title && !!h1s[0] && overlap(title, h1s[0].text), 'Title ↔ H1 topic alignment', 'low',
      'Title and H1 should describe the same clear topic/entity')
  ];

  // ── scoring ──
  const scores = {};
  for (const k of Object.keys(C)) scores[k] = scoreChecks(C[k]);
  const weights = { structuredData: 0.28, answerContent: 0.24, crawlerAccess: 0.18, structure: 0.12, authority: 0.10, metadata: 0.08 };
  let overall = 0;
  for (const k of Object.keys(weights)) overall += (scores[k] || 0) * weights[k];
  overall = Math.round(overall);

  // ── prioritized fixes (failed/warn checks, high importance first) ──
  const impRank = { high: 0, medium: 1, low: 2 };
  const tasks = [];
  for (const k of Object.keys(C)) for (const c of C[k]) if (c.status !== 'pass') tasks.push(c);
  tasks.sort((a, b) => impRank[a.importance] - impRank[b.importance]);
  const taskList = tasks.slice(0, 8).map(c => c.name + ' — ' + c.detail);

  return {
    overall,
    scores,
    checks: C,
    tasks: taskList,
    stats: { words, headings: headings.length, schemaTypes: [...ldTypes], blockedBots, hasLlmsTxt }
  };
}

// ── check helpers ──
function chk(pass, name, importance, detail) {
  return { name, status: pass ? 'pass' : (importance === 'low' ? 'warn' : 'fail'), importance, detail };
}
function scoreChecks(list) {
  const w = { high: 3, medium: 2, low: 1 };
  let got = 0, max = 0;
  for (const c of list) { max += w[c.importance]; if (c.status === 'pass') got += w[c.importance]; else if (c.status === 'warn') got += w[c.importance] * 0.4; }
  return max ? Math.round((got / max) * 100) : 0;
}

// ── text helpers ──
function stripTags(s) {
  return (s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function hasConciseAnswer(text) {
  const first = text.slice(0, 400);
  const sentences = first.split(/[.!?]\s/).filter(s => s.trim().length > 20);
  return sentences.length >= 1 && first.length >= 80;
}
function overlap(a, b) {
  const wa = new Set((a || '').toLowerCase().match(/\b\w{4,}\b/g) || []);
  const wb = (b || '').toLowerCase().match(/\b\w{4,}\b/g) || [];
  if (!wb.length) return false;
  return wb.some(w => wa.has(w));
}
function countOutbound(html, baseUrl) {
  let host = '';
  try { host = new URL(baseUrl).hostname.replace(/^www\./, ''); } catch (e) {}
  let n = 0;
  for (const m of html.matchAll(/<a[^>]+href=["']https?:\/\/([^/"']+)/gi)) {
    const h = m[1].replace(/^www\./, '');
    if (host && h !== host && !h.endsWith('.' + host)) n++;
  }
  return n;
}

// ── fetch ──
function fetchURL(urlStr, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { return reject(new Error('Invalid URL')); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SEORocketAEO/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 12000
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
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
function fetchText(urlStr) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { return reject(new Error('bad url')); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname, path: parsed.pathname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      method: 'GET', headers: { 'User-Agent': 'SEORocketAEO/1.0' }, timeout: 8000
    }, (res) => {
      if (res.statusCode >= 400) { res.resume(); return resolve(null); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}
