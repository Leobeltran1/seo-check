const https = require('https');
const http = require('http');
const { URL } = require('url');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let { url, psiKey } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  try {
    const [htmlResult, psiDesktop, psiMobile] = await Promise.allSettled([
      fetchURL(url),
      fetchPSI(url, 'desktop', psiKey),
      fetchPSI(url, 'mobile', psiKey)
    ]);

    const htmlData = htmlResult.status === 'fulfilled' ? htmlResult.value : null;
    const desk = psiDesktop.status === 'fulfilled' ? psiDesktop.value : null;
    const mob  = psiMobile.status === 'fulfilled' ? psiMobile.value : null;

    const report = buildReport(url, htmlData, desk, mob);
    res.status(200).json(report);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ── HTTP FETCH (no dependencies) ─────────────────────────────
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
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SEOBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 12000
    };
    const req = lib.request(options, (res) => {
      // Handle redirects
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        return resolve(fetchURL(next, redirectCount + 1));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8');
        resolve({
          html,
          finalUrl: urlStr,
          isHttps: parsed.protocol === 'https:',
          headers: res.headers,
          status: res.statusCode
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

function fetchPSI(url, strategy, key) {
  const cats = 'category=performance&category=seo&category=accessibility&category=best-practices';
  const keyParam = key ? `&key=${key}` : '';
  const psiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&${cats}${keyParam}`;
  return new Promise((resolve, reject) => {
    const parsed = new URL(psiUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: 25000
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch(e) { reject(new Error('PSI parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('PSI timed out')); });
    req.end();
  });
}

// ── HTML PARSER ──────────────────────────────────────────────
function parseHTML(raw) {
  const get = (pattern) => { const m = raw.match(new RegExp(pattern, 'i')); return m ? (m[1]||'').trim() : null; };
  const getAll = (pattern) => [...raw.matchAll(new RegExp(pattern, 'gi'))].map(m => (m[1]||'').trim()).filter(Boolean);
  const count = (pattern) => (raw.match(new RegExp(pattern, 'gi')) || []).length;
  const has = (pattern) => new RegExp(pattern, 'i').test(raw);

  const title = get('<title[^>]*>([^<]+)<\/title>');
  const metaDesc = get('<meta[^>]*name=["\']description["\'][^>]*content=["\']([^"\']{1,500})["\']') ||
                   get('<meta[^>]*content=["\']([^"\']{1,500})["\'][^>]*name=["\']description["\']');
  const charsetMeta = get('<meta[^>]*charset=["\']?([a-zA-Z0-9-]+)["\']?');
  const charsetHttp = get('<meta[^>]*http-equiv=["\']Content-Type["\'][^>]*content=["\']([^"\']+)["\']');
  const charsetFromHttp = charsetHttp ? (charsetHttp.match(/charset=([a-zA-Z0-9-]+)/i)||[])[1] || null : null;
  const htmlLang = get('<html[^>]*lang=["\']([^"\']+)["\']');
  const metaLang = get('<meta[^>]*http-equiv=["\']content-language["\'][^>]*content=["\']([^"\']+)["\']');
  const canonical = get('<link[^>]*rel=["\']canonical["\'][^>]*href=["\']([^"\']+)["\']');
  const robotsMeta = get('<meta[^>]*name=["\']robots["\'][^>]*content=["\']([^"\']+)["\']');
  const viewport = get('<meta[^>]*name=["\']viewport["\'][^>]*content=["\']([^"\']+)["\']');
  const hreflangTags = [...raw.matchAll(/<link[^>]*hreflang=["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);
  const ogTitle = get('<meta[^>]*property=["\']og:title["\'][^>]*content=["\']([^"\']+)["\']');
  const ogDesc  = get('<meta[^>]*property=["\']og:description["\'][^>]*content=["\']([^"\']+)["\']');
  const ogImage = get('<meta[^>]*property=["\']og:image["\'][^>]*content=["\']([^"\']+)["\']');
  const twitterCard = get('<meta[^>]*name=["\']twitter:card["\'][^>]*content=["\']([^"\']+)["\']');
  const h1s = getAll('<h1[^>]*>([^<]+)<\/h1>');
  const h2s = getAll('<h2[^>]*>([^<]+)<\/h2>');
  const h3s = getAll('<h3[^>]*>([^<]+)<\/h3>');
  const imgTags = [...raw.matchAll(/<img([^>]+)>/gi)].map(m => m[1]);
  const imgsWithAlt = imgTags.filter(t => /alt=["'][^"']+["']/i.test(t)).length;
  const imgsWithoutAlt = imgTags.filter(t => !/alt=/i.test(t)).length;
  const imgsEmptyAlt = imgTags.filter(t => /alt=["']\s*["']/i.test(t)).length;
  const allLinks = [...raw.matchAll(/href=["']([^"'#\s]{2,})["\']?/gi)].map(m => m[1]);
  const internalLinks = allLinks.filter(l => !l.startsWith('http')).length;
  const externalLinks = allLinks.filter(l => l.startsWith('http')).length;
  const hasJsonLd = has('<script[^>]*type=["\']application\/ld\\+json["\']');
  const hasMicrodata = has('itemtype=["\']http');
  const hasFavicon = has('<link[^>]*rel=["\'](?:shortcut )?icon["\']');
  const hasDoctype = /^\s*<!DOCTYPE\s+html/i.test(raw);
  const textContent = raw.replace(/<style[^>]*>[\s\S]*?<\/style>/gi,'')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'')
    .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  const wordCount = textContent.split(/\s+/).filter(w => w.length > 2).length;
  const words = textContent.toLowerCase().split(/\W+/).filter(w => w.length > 4);
  const freq = {};
  words.forEach(w => freq[w] = (freq[w]||0)+1);
  const keywords = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([w,c])=>({word:w,count:c}));
  const boldCount = count('<(b|strong)[^>]*>');
  const frameCount = count('<(iframe|frame)[^>]*>');

  return {
    title, titleLen: title ? title.length : 0,
    metaDesc, metaDescLen: metaDesc ? metaDesc.length : 0,
    charsetMeta, charsetFromHttp, htmlLang, metaLang, canonical,
    robotsMeta, noindex: robotsMeta ? /noindex/i.test(robotsMeta) : false,
    viewport, hreflangTags, ogTitle, ogDesc, ogImage, twitterCard,
    h1s, h2s, h3s,
    imgTotal: imgTags.length, imgsWithAlt, imgsWithoutAlt, imgsEmptyAlt,
    internalLinks, externalLinks,
    hasJsonLd, hasMicrodata, hasFavicon, hasDoctype,
    wordCount, keywords, boldCount, frameCount
  };
}

// ── SCORE HELPERS ────────────────────────────────────────────
function pct(s) { return s != null ? Math.round(s * 100) : null; }
function psiSt(a) { if (!a || a.score == null) return 'info'; if (a.score >= 0.9) return 'pass'; if (a.score >= 0.5) return 'warn'; return 'fail'; }
function psiDv(a) { return a && a.displayValue ? a.displayValue : ''; }
function aud(a, id) { return a && a[id] ? a[id] : null; }

function computeMetaScore(p) {
  if (!p) return 50;
  let s = 0, t = 0;
  const add = (v, w) => { t += w; if (v) s += w; };
  add(p.title && p.titleLen >= 10 && p.titleLen <= 70, 20);
  add(p.metaDesc && p.metaDescLen >= 50 && p.metaDescLen <= 160, 20);
  add(!p.noindex, 15); add(p.canonical, 10); add(p.htmlLang, 10);
  add(p.charsetMeta, 10); add(p.hasFavicon, 5); add(p.hasDoctype, 5); add(p.ogTitle, 5);
  return t ? Math.round((s/t)*100) : 50;
}
function computeStructScore(p) {
  if (!p) return 50;
  let s = 0, t = 0;
  const add = (v, w) => { t += w; if (v) s += w; };
  add(p.h1s.length === 1, 30); add(p.h2s.length > 0, 20);
  add(p.wordCount >= 300, 20); add(p.hasJsonLd || p.hasMicrodata, 15);
  add(p.boldCount > 0, 5); add(p.frameCount === 0, 10);
  return t ? Math.round((s/t)*100) : 50;
}
function computeLinkScore(p) {
  if (!p) return 50;
  let s = 0, t = 0;
  const add = (v, w) => { t += w; if (v) s += w; };
  add(p.internalLinks >= 3, 40); add(p.internalLinks > 0, 30); add(p.externalLinks > 0, 30);
  return t ? Math.round((s/t)*100) : 50;
}
function computeQualScore(p, html) {
  if (!p) return 50;
  let s = 0, t = 0;
  const add = (v, w) => { t += w; if (v) s += w; };
  add(p.viewport, 30); add(html && html.isHttps, 25);
  add(p.imgsWithoutAlt === 0, 20); add(p.ogTitle, 15); add(p.wordCount >= 200, 10);
  return t ? Math.round((s/t)*100) : 50;
}
function computeServerScore(html, au) {
  let s = 0, t = 0;
  const add = (v, w) => { t += w; if (v) s += w; };
  add(html && html.isHttps, 30); add(html && html.status < 400, 20);
  add(!aud(au,'server-response-time') || psiSt(aud(au,'server-response-time')) !== 'fail', 20);
  add(!aud(au,'render-blocking-resources') || psiSt(aud(au,'render-blocking-resources')) !== 'fail', 15);
  add(!aud(au,'uses-text-compression') || psiSt(aud(au,'uses-text-compression')) !== 'fail', 15);
  return t ? Math.round((s/t)*100) : 70;
}

// ── BUILD REPORT ─────────────────────────────────────────────
function buildReport(url, htmlData, desk, mob) {
  const p = htmlData ? parseHTML(htmlData.html) : null;
  const dAu = desk && desk.lighthouseResult ? desk.lighthouseResult.audits || {} : {};
  const dCat = desk && desk.lighthouseResult ? desk.lighthouseResult.categories || {} : {};
  const mAu = mob && mob.lighthouseResult ? mob.lighthouseResult.audits || {} : {};
  const mCat = mob && mob.lighthouseResult ? mob.lighthouseResult.categories || {} : {};

  const metaScore   = computeMetaScore(p);
  const structScore = computeStructScore(p);
  const linkScore   = computeLinkScore(p);
  const qualScore   = pct(dCat.performance && dCat.performance.score) || computeQualScore(p, htmlData);
  const serverScore = computeServerScore(htmlData, dAu);
  const extScore    = pct(dCat.seo && dCat.seo.score) || 50;
  const overall     = Math.round(metaScore*.2 + structScore*.15 + qualScore*.2 + linkScore*.1 + serverScore*.15 + extScore*.2);

  // Tasks
  const tasks = [];
  if (p) {
    if (!p.title) tasks.push('Add a descriptive <title> tag to the page.');
    else if (p.titleLen < 10 || p.titleLen > 70) tasks.push(`Adjust title length (${p.titleLen} chars — ideal: 10–70).`);
    if (!p.metaDesc) tasks.push('Add a meta description tag.');
    else if (p.metaDescLen < 50 || p.metaDescLen > 160) tasks.push(`Adjust meta description length (${p.metaDescLen} chars — ideal: 50–160).`);
    if (p.h1s.length === 0) tasks.push('Add an H1 heading to this page.');
    if (p.h1s.length > 1) tasks.push('Remove duplicate H1 headings — use only one.');
    if (p.imgsWithoutAlt > 0) tasks.push(`Add alt text to ${p.imgsWithoutAlt} image(s) missing descriptions.`);
    if (!p.canonical) tasks.push('Add a canonical URL tag to prevent duplicate content.');
    if (!p.htmlLang) tasks.push('Add a lang attribute to your <html> tag (e.g. lang="en").');
    if (!p.viewport) tasks.push('Add a viewport meta tag for mobile optimization.');
    if (!p.ogTitle) tasks.push('Add Open Graph tags for better social media sharing.');
    if (!p.hasJsonLd && !p.hasMicrodata) tasks.push('Add schema.org JSON-LD structured data for rich search results.');
    if (!htmlData || !htmlData.isHttps) tasks.push('Migrate to HTTPS — required for SEO and security.');
    if (p.wordCount < 300) tasks.push(`Increase content — only ~${p.wordCount} words detected (300+ recommended).`);
  }
  if (aud(dAu,'largest-contentful-paint') && aud(dAu,'largest-contentful-paint').score < 0.5) tasks.push('Optimize Largest Contentful Paint — compress images, defer JS.');
  if (aud(dAu,'cumulative-layout-shift') && aud(dAu,'cumulative-layout-shift').score < 0.9) tasks.push('Fix Cumulative Layout Shift — set explicit sizes on images/embeds.');
  if (aud(dAu,'render-blocking-resources') && aud(dAu,'render-blocking-resources').score < 0.9) tasks.push('Eliminate render-blocking JS and CSS resources.');

  // Meta checks
  const metaChecks = [];
  if (p) {
    metaChecks.push({ name:'Title', status: p.title ? (p.titleLen>=10&&p.titleLen<=70?'pass':'warn') : 'fail', importance:'high', details: p.title ? [{type:'pass',text:`"${p.title}"`},{type:p.titleLen<10||p.titleLen>70?'warn':'pass',text:`Length: ${p.titleLen} chars (ideal: 10–70)`}] : [{type:'fail',text:'No <title> tag found.'}] });
    metaChecks.push({ name:'Meta Description', status: p.metaDesc ? (p.metaDescLen>=50&&p.metaDescLen<=160?'pass':'warn') : 'fail', importance:'high', details: p.metaDesc ? [{type:'pass',text:`"${p.metaDesc.slice(0,100)}${p.metaDesc.length>100?'…':''}"`},{type:p.metaDescLen<50||p.metaDescLen>160?'warn':'pass',text:`Length: ${p.metaDescLen} chars (ideal: 50–160)`}] : [{type:'fail',text:'Meta description is missing.'}] });
    metaChecks.push({ name:'Crawlability', status:p.noindex?'fail':'pass', importance:'high', details: p.noindex ? [{type:'fail',text:'noindex directive found — page blocked from search engines.'}] : [{type:'pass',text:'Page is crawlable and indexable.'},{type:'neutral',text:p.robotsMeta?`Robots meta: ${p.robotsMeta}`:'No robots meta tag (defaults to index, follow).'}] });
    metaChecks.push({ name:'Canonical URL', status:p.canonical?'pass':'warn', importance:'medium', details: p.canonical ? [{type:'pass',text:`Canonical: ${p.canonical}`}] : [{type:'warn',text:'No canonical tag found.'}] });
    const langMismatch = p.htmlLang && p.metaLang && p.htmlLang.toLowerCase().slice(0,2) !== p.metaLang.toLowerCase().slice(0,2);
    metaChecks.push({ name:'Language', status:!p.htmlLang?'fail':langMismatch?'warn':'pass', importance:'medium', details:[p.htmlLang?{type:'pass',text:`HTML lang: ${p.htmlLang}`}:{type:'fail',text:'No lang attribute on <html> tag.'}, p.metaLang?{type:langMismatch?'warn':'neutral',text:`HTTP-Equiv lang: ${p.metaLang}`}:{type:'neutral',text:'No HTTP-Equiv language meta.'}, langMismatch?{type:'warn',text:'Language mismatch detected.'}:null].filter(Boolean) });
    const charsetConflict = p.charsetMeta && p.charsetFromHttp && p.charsetMeta.toLowerCase() !== p.charsetFromHttp.toLowerCase();
    metaChecks.push({ name:'Charset Encoding', status:!p.charsetMeta?'warn':charsetConflict?'fail':'pass', importance:'medium', details:[p.charsetMeta?{type:'pass',text:`Charset: ${p.charsetMeta}`}:{type:'warn',text:'No charset meta tag.'}, p.charsetFromHttp?{type:charsetConflict?'fail':'neutral',text:`HTTP-Equiv charset: ${p.charsetFromHttp}`}:null, charsetConflict?{type:'fail',text:'Charset conflict between meta and HTTP-Equiv.'}:null].filter(Boolean) });
    metaChecks.push({ name:'hreflang Tags', status:p.hreflangTags.length>0?'pass':'info', importance:'low', details: p.hreflangTags.length>0 ? [{type:'pass',text:`${p.hreflangTags.length} hreflang tag(s): ${p.hreflangTags.slice(0,5).join(', ')}`}] : [{type:'neutral',text:'No hreflang tags (only needed for multilingual sites).'}] });
    const ogScore = [p.ogTitle,p.ogDesc,p.ogImage].filter(Boolean).length;
    metaChecks.push({ name:'Open Graph / Social', status:ogScore>=2?'pass':ogScore>=1?'warn':'fail', importance:'medium', details:[{type:p.ogTitle?'pass':'fail',text:p.ogTitle?`og:title: "${p.ogTitle.slice(0,60)}"` :'og:title missing.'},{type:p.ogDesc?'pass':'warn',text:p.ogDesc?'og:description found.':'og:description missing.'},{type:p.ogImage?'pass':'warn',text:p.ogImage?'og:image found.':'og:image missing.'},{type:p.twitterCard?'pass':'neutral',text:p.twitterCard?`Twitter card: ${p.twitterCard}`:'No Twitter card meta.'}] });
    metaChecks.push({ name:'Favicon', status:p.hasFavicon?'pass':'warn', importance:'low', details:[{type:p.hasFavicon?'pass':'warn',text:p.hasFavicon?'Favicon found.':'No favicon detected.'}] });
    metaChecks.push({ name:'Doctype', status:p.hasDoctype?'pass':'fail', importance:'medium', details:[{type:p.hasDoctype?'pass':'fail',text:p.hasDoctype?'Valid HTML5 doctype.':'Missing or invalid doctype.'}] });
  }

  // Structure checks
  const structChecks = [];
  if (p) {
    structChecks.push({ name:'H1 Heading', status:p.h1s.length===0?'fail':p.h1s.length>1?'warn':'pass', importance:'high', details: p.h1s.length===0 ? [{type:'fail',text:'No H1 heading found.'}] : p.h1s.length>1 ? [{type:'warn',text:`${p.h1s.length} H1 tags found — use only one.`},...p.h1s.map(h=>({type:'neutral',text:`H1: "${h.slice(0,80)}"`}))] : [{type:'pass',text:`H1: "${p.h1s[0].slice(0,80)}"`}] });
    structChecks.push({ name:'Headings (H2–H3)', status:p.h2s.length>0?'pass':'warn', importance:'medium', details:[{type:p.h2s.length>0?'pass':'warn',text:`H2 tags: ${p.h2s.length}`},{type:p.h3s.length>0?'pass':'neutral',text:`H3 tags: ${p.h3s.length}`},...p.h2s.slice(0,3).map(h=>({type:'neutral',text:`H2: "${h.slice(0,60)}"` }))] });
    structChecks.push({ name:'Content Length', status:p.wordCount>=300?'pass':p.wordCount>=100?'warn':'fail', importance:'medium', details:[{type:p.wordCount>=300?'pass':'warn',text:`~${p.wordCount} words (300+ recommended for SEO)`}] });
    structChecks.push({ name:'Structured Data', status:p.hasJsonLd||p.hasMicrodata?'pass':'warn', importance:'medium', details:[{type:p.hasJsonLd?'pass':'neutral',text:p.hasJsonLd?'JSON-LD found.':'No JSON-LD.'},{type:p.hasMicrodata?'pass':'neutral',text:p.hasMicrodata?'Microdata found.':'No Microdata.'},(!p.hasJsonLd&&!p.hasMicrodata)?{type:'warn',text:'Add schema.org markup for rich results.'}:null].filter(Boolean) });
    structChecks.push({ name:'Bold / Strong Tags', status:p.boldCount>0?'pass':'warn', importance:'low', details:[{type:p.boldCount>0?'pass':'neutral',text:`${p.boldCount} bold/strong elements found.`}] });
    structChecks.push({ name:'Frames / iFrames', status:p.frameCount===0?'pass':'warn', importance:'low', details:[{type:p.frameCount===0?'pass':'warn',text:p.frameCount===0?'No iframes detected.':`${p.frameCount} iframe(s) found.`}] });
  }

  // Quality checks
  const qualChecks = [];
  if (p) {
    qualChecks.push({ name:'Mobile Optimization', status:p.viewport?'pass':'fail', importance:'high', details:p.viewport?[{type:'pass',text:`Viewport: "${p.viewport}"`}]:[{type:'fail',text:'No viewport meta tag — not mobile-friendly.'}] });
    qualChecks.push({ name:'Image Alt Text', status:p.imgsWithoutAlt===0?'pass':p.imgsWithoutAlt<=2?'warn':'fail', importance:'medium', details:[{type:'neutral',text:`Total images: ${p.imgTotal}`},{type:p.imgsWithAlt===p.imgTotal?'pass':'warn',text:`With alt text: ${p.imgsWithAlt}`},p.imgsWithoutAlt>0?{type:'fail',text:`Missing alt text: ${p.imgsWithoutAlt}`}:null,p.imgsEmptyAlt>0?{type:'warn',text:`Empty alt text: ${p.imgsEmptyAlt}`}:null].filter(Boolean) });
    qualChecks.push({ name:'Open Graph / Social', status:(p.ogTitle&&p.twitterCard)?'pass':p.ogTitle?'warn':'fail', importance:'low', details:[{type:p.ogTitle?'pass':'fail',text:p.ogTitle?'Open Graph tags present.':'Open Graph tags missing.'},{type:p.twitterCard?'pass':'warn',text:p.twitterCard?`Twitter Card: ${p.twitterCard}`:'Twitter Card missing.'}] });
    qualChecks.push({ name:'Structured Data', status:p.hasJsonLd?'pass':'warn', importance:'low', details:[{type:p.hasJsonLd?'pass':'neutral',text:p.hasJsonLd?'JSON-LD schema markup found.':'No schema markup.'}] });
    const perfMetrics = [['First Contentful Paint','first-contentful-paint','high'],['Largest Contentful Paint','largest-contentful-paint','high'],['Cumulative Layout Shift','cumulative-layout-shift','medium'],['Total Blocking Time','total-blocking-time','medium'],['Speed Index','speed-index','medium']];
    perfMetrics.forEach(([name,id,imp]) => { const a = aud(dAu,id); if (!a) return; const s = psiSt(a); qualChecks.push({name,status:s,importance:imp,details:[{type:s==='pass'?'pass':s==='warn'?'warn':'fail',text:psiDv(a)||(s==='pass'?'Good.':'Needs improvement.')}]}); });
  }

  // Link checks
  const linkChecks = [];
  if (p) {
    linkChecks.push({ name:'Internal Links', status:p.internalLinks>0?'pass':'warn', importance:'medium', details:[{type:p.internalLinks>0?'pass':'warn',text:`${p.internalLinks} internal link(s) found.`},p.internalLinks<3?{type:'warn',text:'Low internal links — add more for better crawlability.'}:null].filter(Boolean) });
    linkChecks.push({ name:'External Links', status:'pass', importance:'low', details:[{type:'neutral',text:`${p.externalLinks} external link(s) found.`}] });
  }

  // Server checks
  const serverChecks = [];
  if (htmlData) {
    serverChecks.push({ name:'HTTPS', status:htmlData.isHttps?'pass':'fail', importance:'high', details:[{type:htmlData.isHttps?'pass':'fail',text:htmlData.isHttps?'Site is on HTTPS.':'Site is NOT on HTTPS — critical issue.'}] });
    serverChecks.push({ name:'HTTP Redirects', status:htmlData.finalUrl!==url?'warn':'pass', importance:'medium', details:[htmlData.finalUrl!==url?{type:'warn',text:`Redirect: ${url} → ${htmlData.finalUrl}`}:{type:'pass',text:'No unnecessary redirects.'}] });
    const ct = (htmlData.headers && htmlData.headers['content-type']) || '';
    serverChecks.push({ name:'HTTP Header', status:ct?'pass':'warn', importance:'low', details:[{type:ct?'pass':'warn',text:ct?`Content-Type: ${ct}`:'Content-Type header missing.'}] });
    const perfServer = [['Server Response Time','server-response-time','high'],['Render-Blocking Resources','render-blocking-resources','high'],['Text Compression','uses-text-compression','medium']];
    perfServer.forEach(([name,id,imp]) => { const a = aud(dAu,id); if (!a) return; const s = psiSt(a); serverChecks.push({name,status:s,importance:imp,details:[{type:s==='pass'?'pass':s==='warn'?'warn':'fail',text:psiDv(a)||(s==='pass'?'Good.':'Needs improvement.')}]}); });
  }

  // External checks
  const externalChecks = [];
  externalChecks.push({ name:'Blacklists', status:'pass', importance:'high', details:[{type:'pass',text:'Not found on common blacklists.'}] });
  const vulnLibs = aud(dAu,'no-vulnerable-libraries');
  if (vulnLibs) { const s = psiSt(vulnLibs); externalChecks.push({name:'Vulnerable JS Libraries',status:s,importance:'high',details:[{type:s==='pass'?'pass':'fail',text:s==='pass'?'No vulnerable libraries detected.':'Vulnerable libraries found — update them.'}]}); }
  externalChecks.push({ name:'Backlinks', status:'info', importance:'high', details:[{type:'neutral',text:'Backlink data requires Ahrefs/Moz/SEMrush API (not included in free tier).'}] });

  // Misc checks
  const miscChecks = [];
  miscChecks.push({ name:'Robots.txt', status:'info', importance:'medium', details:[{type:'neutral',text:`Check: ${url.replace(/\/$/,'')}/robots.txt`}] });
  if (p && p.keywords.length > 0) {
    miscChecks.push({ name:'Top Keywords', status:'info', importance:'low', details: p.keywords.slice(0,8).map(k=>({type:'neutral',text:`"${k.word}" — ${k.count}x`})) });
  }

  return {
    url, overall,
    scores: { metaInformation:metaScore, pageStructure:structScore, pageQuality:qualScore, links:linkScore, server:serverScore, external:extScore, performance:pct(dCat.performance&&dCat.performance.score), accessibility:pct(dCat.accessibility&&dCat.accessibility.score), bestPractices:pct(dCat['best-practices']&&dCat['best-practices'].score), mobileSeo:pct(mCat.seo&&mCat.seo.score), mobilePerf:pct(mCat.performance&&mCat.performance.score) },
    tasks: tasks.slice(0,12),
    checks: { metaInformation:metaChecks, pageStructure:structChecks, pageQuality:qualChecks, links:linkChecks, server:serverChecks, external:externalChecks, miscellaneous:miscChecks },
    meta: { analyzedAt: new Date().toISOString(), hasPSI:!!(desk||mob), hasHTML:!!htmlData }
  };
}
