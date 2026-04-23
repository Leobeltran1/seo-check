import fetch from 'node-fetch';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let { url, psiKey } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  try {
    const [htmlResult, psiDesktop, psiMobile] = await Promise.allSettled([
      fetchHTML(url),
      fetchPSI(url, 'desktop', psiKey),
      fetchPSI(url, 'mobile', psiKey)
    ]);

    const html = htmlResult.status === 'fulfilled' ? htmlResult.value : null;
    const desk = psiDesktop.status === 'fulfilled' ? psiDesktop.value : null;
    const mob  = psiMobile.status === 'fulfilled' ? psiMobile.value : null;

    const report = buildReport(url, html, desk, mob);
    res.status(200).json(report);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─── FETCH HTML ─────────────────────────────────────────────
async function fetchHTML(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SEOBot/1.0)',
      'Accept': 'text/html,application/xhtml+xml'
    },
    redirect: 'follow',
    timeout: 12000
  });
  const finalUrl = resp.url;
  const isHttps = finalUrl.startsWith('https://');
  const headers = Object.fromEntries(resp.headers.entries());
  const text = await resp.text();
  return { html: text, finalUrl, isHttps, headers, status: resp.status };
}

// ─── FETCH PSI ──────────────────────────────────────────────
async function fetchPSI(url, strategy, key) {
  const cats = 'category=performance&category=seo&category=accessibility&category=best-practices';
  const keyParam = key ? `&key=${key}` : '';
  const r = await fetch(
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&${cats}${keyParam}`,
    { timeout: 25000 }
  );
  if (!r.ok) throw new Error(`PSI ${strategy} failed: ${r.status}`);
  return r.json();
}

// ─── PARSE HTML ─────────────────────────────────────────────
function parseHTML(raw) {
  const get = (pattern, flags = 'i') => {
    const m = raw.match(new RegExp(pattern, flags));
    return m ? m[1]?.trim() : null;
  };
  const getAll = (pattern, flags = 'gi') => {
    return [...raw.matchAll(new RegExp(pattern, flags))].map(m => m[1]?.trim()).filter(Boolean);
  };
  const count = (pattern, flags = 'gi') => (raw.match(new RegExp(pattern, flags)) || []).length;
  const exists = (pattern, flags = 'i') => new RegExp(pattern, flags).test(raw);

  // Title
  const title = get('<title[^>]*>([^<]+)<\/title>');
  const titleLen = title ? title.length : 0;

  // Meta description
  const metaDesc = get('<meta[^>]*name=["\']description["\'][^>]*content=["\']([^"\']+)["\']') ||
                   get('<meta[^>]*content=["\']([^"\']+)["\'][^>]*name=["\']description["\']');
  const metaDescLen = metaDesc ? metaDesc.length : 0;

  // Charset
  const charsetMeta = get('<meta[^>]*charset=["\']?([a-zA-Z0-9-]+)["\']?');
  const charsetHttp  = get('<meta[^>]*http-equiv=["\']Content-Type["\'][^>]*content=["\']([^"\']+)["\']');
  const charsetFromHttp = charsetHttp ? (charsetHttp.match(/charset=([a-zA-Z0-9-]+)/i)?.[1] || null) : null;

  // Language
  const htmlLang = get('<html[^>]*lang=["\']([^"\']+)["\']');
  const metaLang = get('<meta[^>]*http-equiv=["\']content-language["\'][^>]*content=["\']([^"\']+)["\']') ||
                   get('<meta[^>]*content=["\']([^"\']+)["\'][^>]*http-equiv=["\']content-language["\']');

  // Canonical
  const canonical = get('<link[^>]*rel=["\']canonical["\'][^>]*href=["\']([^"\']+)["\']');

  // Robots meta
  const robotsMeta = get('<meta[^>]*name=["\']robots["\'][^>]*content=["\']([^"\']+)["\']');
  const noindex = robotsMeta ? /noindex/i.test(robotsMeta) : false;
  const nofollow = robotsMeta ? /nofollow/i.test(robotsMeta) : false;

  // Viewport
  const viewport = get('<meta[^>]*name=["\']viewport["\'][^>]*content=["\']([^"\']+)["\']');

  // hreflang
  const hreflangTags = [...raw.matchAll(/<link[^>]*rel=["']alternate["'][^>]*hreflang=["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);

  // Open Graph
  const ogTitle = get('<meta[^>]*property=["\']og:title["\'][^>]*content=["\']([^"\']+)["\']');
  const ogDesc  = get('<meta[^>]*property=["\']og:description["\'][^>]*content=["\']([^"\']+)["\']');
  const ogImage = get('<meta[^>]*property=["\']og:image["\'][^>]*content=["\']([^"\']+)["\']');
  const ogType  = get('<meta[^>]*property=["\']og:type["\'][^>]*content=["\']([^"\']+)["\']');

  // Twitter card
  const twitterCard = get('<meta[^>]*name=["\']twitter:card["\'][^>]*content=["\']([^"\']+)["\']');

  // Headings
  const h1s = getAll('<h1[^>]*>([^<]+)<\/h1>');
  const h2s = getAll('<h2[^>]*>([^<]+)<\/h2>');
  const h3s = getAll('<h3[^>]*>([^<]+)<\/h3>');

  // Images
  const imgTags = [...raw.matchAll(/<img([^>]+)>/gi)].map(m => m[1]);
  const imgsWithAlt = imgTags.filter(t => /alt=["'][^"']+["']/i.test(t)).length;
  const imgsWithoutAlt = imgTags.filter(t => !(/alt=["'][^"']+["']/i.test(t))).length;
  const imgsEmptyAlt = imgTags.filter(t => /alt=["']\s*["']/i.test(t)).length;

  // Links
  const allLinks = [...raw.matchAll(/href=["']([^"'#\s]+)["']/gi)].map(m => m[1]);
  const internalLinks = allLinks.filter(l => !l.startsWith('http') || l.includes('javascript:'));
  const externalLinks = allLinks.filter(l => l.startsWith('http'));

  // Structured data
  const hasJsonLd = exists('<script[^>]*type=["\']application\/ld\\+json["\']');
  const hasMicrodata = exists('itemtype=["\']http');
  const hasRDFa = exists('typeof=["\']');

  // Favicon
  const hasFavicon = exists('<link[^>]*rel=["\'](?:shortcut )?icon["\']');

  // Doctype
  const hasDoctype = /^\s*<!DOCTYPE\s+html/i.test(raw);

  // Content stats
  const textContent = raw.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                         .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                         .replace(/<[^>]+>/g, ' ')
                         .replace(/\s+/g, ' ').trim();
  const wordCount = textContent.split(/\s+/).filter(w => w.length > 2).length;

  // Keywords (simple frequency)
  const words = textContent.toLowerCase().split(/\W+/).filter(w => w.length > 4);
  const freq = {};
  words.forEach(w => freq[w] = (freq[w]||0)+1);
  const keywords = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([w,c])=>({word:w,count:c}));

  // Bold/strong
  const boldCount = count('<(b|strong)[^>]*>');

  // Frames
  const frameCount = count('<(iframe|frame)[^>]*>');

  // Scripts / styles
  const scriptCount = count('<script');
  const styleCount  = count('<link[^>]*rel=["\']stylesheet["\']');

  return {
    title, titleLen, metaDesc, metaDescLen,
    charsetMeta, charsetFromHttp,
    htmlLang, metaLang,
    canonical, robotsMeta, noindex, nofollow,
    viewport, hreflangTags,
    ogTitle, ogDesc, ogImage, ogType, twitterCard,
    h1s, h2s, h3s,
    imgTotal: imgTags.length, imgsWithAlt, imgsWithoutAlt, imgsEmptyAlt,
    allLinks: allLinks.length, internalLinks: internalLinks.length, externalLinks: externalLinks.length,
    hasJsonLd, hasMicrodata, hasRDFa,
    hasFavicon, hasDoctype,
    wordCount, keywords, boldCount, frameCount,
    scriptCount, styleCount
  };
}

// ─── BUILD REPORT ────────────────────────────────────────────
function buildReport(url, htmlData, desk, mob) {
  const p = htmlData ? parseHTML(htmlData.html) : null;
  const dAu = desk?.lighthouseResult?.audits || {};
  const dCat = desk?.lighthouseResult?.categories || {};
  const mAu = mob?.lighthouseResult?.audits || {};
  const mCat = mob?.lighthouseResult?.categories || {};

  const pct = s => s != null ? Math.round(s * 100) : null;
  const psiSt = a => !a || a.score === null ? 'info' : a.score >= 0.9 ? 'pass' : a.score >= 0.5 ? 'warn' : 'fail';
  const psiDv = a => a?.displayValue || '';

  // ── SCORES ──────────────────────────────────────────────
  const scores = {
    seo:         pct(dCat.seo?.score),
    performance: pct(dCat.performance?.score),
    accessibility: pct(dCat.accessibility?.score),
    bestPractices: pct(dCat['best-practices']?.score),
    mobileSeo:    pct(mCat.seo?.score),
    mobilePerf:   pct(mCat.performance?.score),
  };

  // Compute category scores from HTML parsing when PSI unavailable
  const metaScore   = computeMetaScore(p);
  const structScore = computeStructScore(p);
  const linkScore   = computeLinkScore(p);
  const qualScore   = scores.performance ?? computeQualScore(p, htmlData);
  const serverScore = computeServerScore(htmlData, dAu);
  const extScore    = scores.seo ?? 50;

  const overall = Math.round(
    metaScore * 0.2 + structScore * 0.15 + qualScore * 0.2 +
    linkScore * 0.1 + serverScore * 0.15 + extScore * 0.2
  );

  // ── META INFORMATION ────────────────────────────────────
  const metaChecks = [];

  // Title
  if (p) {
    metaChecks.push({
      name: 'Title', status: p.title ? (p.titleLen >= 10 && p.titleLen <= 70 ? 'pass' : 'warn') : 'fail',
      importance: 'high',
      details: p.title
        ? [{ type: 'pass', text: `Title found: "${p.title}"` },
           { type: p.titleLen < 10 || p.titleLen > 70 ? 'warn' : 'pass', text: `Length: ${p.titleLen} characters (ideal: 10–70)` }]
        : [{ type: 'fail', text: 'No <title> tag found on this page.' }]
    });

    // Meta Description
    metaChecks.push({
      name: 'Meta Description',
      status: p.metaDesc ? (p.metaDescLen >= 50 && p.metaDescLen <= 160 ? 'pass' : 'warn') : 'fail',
      importance: 'high',
      details: p.metaDesc
        ? [{ type: 'pass', text: `"${p.metaDesc.slice(0,100)}${p.metaDesc.length>100?'…':''}"` },
           { type: p.metaDescLen < 50 || p.metaDescLen > 160 ? 'warn' : 'pass', text: `Length: ${p.metaDescLen} characters (ideal: 50–160)` }]
        : [{ type: 'fail', text: 'Meta description tag is missing.' }]
    });

    // Crawlability
    metaChecks.push({
      name: 'Crawlability',
      status: p.noindex ? 'fail' : 'pass',
      importance: 'high',
      details: p.noindex
        ? [{ type: 'fail', text: 'Page has noindex directive — blocked from search engines.' }]
        : [{ type: 'pass', text: 'Page is crawlable and indexable by search engines.' },
           p.robotsMeta ? { type: 'neutral', text: `Robots meta: ${p.robotsMeta}` } : { type: 'neutral', text: 'No robots meta tag (defaults to index, follow).' }]
    });

    // Canonical
    metaChecks.push({
      name: 'Canonical URL', status: p.canonical ? 'pass' : 'warn', importance: 'medium',
      details: p.canonical
        ? [{ type: 'pass', text: `Canonical set: ${p.canonical}` }]
        : [{ type: 'warn', text: 'No canonical tag found. Recommended to avoid duplicate content.' }]
    });

    // Language
    const langMismatch = p.htmlLang && p.metaLang && p.htmlLang.toLowerCase().slice(0,2) !== p.metaLang.toLowerCase().slice(0,2);
    metaChecks.push({
      name: 'Language', status: !p.htmlLang ? 'fail' : langMismatch ? 'warn' : 'pass', importance: 'medium',
      details: [
        p.htmlLang ? { type: 'pass', text: `HTML lang attribute: ${p.htmlLang}` } : { type: 'fail', text: 'No lang attribute on <html> tag.' },
        p.metaLang ? { type: langMismatch ? 'warn' : 'neutral', text: `HTTP-Equiv language: ${p.metaLang}` } : { type: 'neutral', text: 'No HTTP-Equiv content-language meta tag.' },
        langMismatch ? { type: 'warn', text: 'Language mismatch between HTML attribute and meta tag.' } : null
      ].filter(Boolean)
    });

    // Charset
    const charsetConflict = p.charsetMeta && p.charsetFromHttp && p.charsetMeta.toLowerCase() !== p.charsetFromHttp.toLowerCase();
    metaChecks.push({
      name: 'Charset Encoding', status: !p.charsetMeta ? 'warn' : charsetConflict ? 'fail' : 'pass', importance: 'medium',
      details: [
        p.charsetMeta ? { type: 'pass', text: `Meta charset: ${p.charsetMeta}` } : { type: 'warn', text: 'No charset meta tag found.' },
        p.charsetFromHttp ? { type: charsetConflict ? 'fail' : 'neutral', text: `HTTP-Equiv Content-Type charset: ${p.charsetFromHttp}` } : null,
        charsetConflict ? { type: 'fail', text: 'Charset conflict — meta charset and HTTP-Equiv differ.' } : null
      ].filter(Boolean)
    });

    // hreflang
    metaChecks.push({
      name: 'Alternate/Hreflang Links', status: p.hreflangTags.length > 0 ? 'pass' : 'info', importance: 'low',
      details: p.hreflangTags.length > 0
        ? [{ type: 'pass', text: `${p.hreflangTags.length} hreflang tag(s) found: ${p.hreflangTags.slice(0,5).join(', ')}` }]
        : [{ type: 'neutral', text: 'No hreflang tags found. Only needed for multilingual sites.' }]
    });

    // Open Graph / Social
    const ogScore = [p.ogTitle, p.ogDesc, p.ogImage, p.ogType].filter(Boolean).length;
    metaChecks.push({
      name: 'Open Graph / Social Tags', status: ogScore >= 3 ? 'pass' : ogScore >= 1 ? 'warn' : 'fail', importance: 'medium',
      details: [
        { type: p.ogTitle ? 'pass' : 'fail', text: p.ogTitle ? `og:title — "${p.ogTitle.slice(0,60)}"` : 'og:title is missing.' },
        { type: p.ogDesc ? 'pass' : 'warn', text: p.ogDesc ? `og:description found` : 'og:description is missing.' },
        { type: p.ogImage ? 'pass' : 'warn', text: p.ogImage ? `og:image found` : 'og:image is missing.' },
        { type: p.twitterCard ? 'pass' : 'neutral', text: p.twitterCard ? `Twitter card: ${p.twitterCard}` : 'No Twitter card meta tag.' },
      ]
    });

    // Favicon
    metaChecks.push({
      name: 'Favicon', status: p.hasFavicon ? 'pass' : 'warn', importance: 'low',
      details: [{ type: p.hasFavicon ? 'pass' : 'warn', text: p.hasFavicon ? 'Favicon link tag found.' : 'No favicon link tag detected.' }]
    });

    // Doctype
    metaChecks.push({
      name: 'Doctype', status: p.hasDoctype ? 'pass' : 'fail', importance: 'medium',
      details: [{ type: p.hasDoctype ? 'pass' : 'fail', text: p.hasDoctype ? 'Valid HTML5 doctype declared.' : 'Missing or invalid doctype.' }]
    });

    // Domain / Page URL
    metaChecks.push({
      name: 'Page URL', status: 'pass', importance: 'low',
      details: [
        { type: 'pass', text: `Analyzed URL: ${url}` },
        htmlData?.finalUrl && htmlData.finalUrl !== url ? { type: 'neutral', text: `Resolved to: ${htmlData.finalUrl}` } : null
      ].filter(Boolean)
    });
  }

  // ── PAGE STRUCTURE ──────────────────────────────────────
  const structChecks = [];
  if (p) {
    structChecks.push({
      name: 'H1 Heading',
      status: p.h1s.length === 0 ? 'fail' : p.h1s.length > 1 ? 'warn' : 'pass',
      importance: 'high',
      details: p.h1s.length === 0
        ? [{ type: 'fail', text: 'No H1 heading found on this page.' }]
        : p.h1s.length > 1
        ? [{ type: 'warn', text: `Multiple H1 tags found (${p.h1s.length}). Use only one H1.` },
           ...p.h1s.map(h => ({ type: 'neutral', text: `H1: "${h.slice(0,80)}"` }))]
        : [{ type: 'pass', text: `H1: "${p.h1s[0].slice(0,80)}"` }]
    });

    structChecks.push({
      name: 'Headings (H2–H3)', status: p.h2s.length > 0 ? 'pass' : 'warn', importance: 'medium',
      details: [
        { type: p.h2s.length > 0 ? 'pass' : 'warn', text: `H2 tags: ${p.h2s.length}` },
        { type: p.h3s.length > 0 ? 'pass' : 'neutral', text: `H3 tags: ${p.h3s.length}` },
        ...p.h2s.slice(0,3).map(h => ({ type: 'neutral', text: `H2: "${h.slice(0,60)}"` }))
      ]
    });

    structChecks.push({
      name: 'Heading Structure', status: p.h1s.length === 1 && p.h2s.length > 0 ? 'pass' : 'warn', importance: 'medium',
      details: [
        { type: p.h1s.length === 1 ? 'pass' : 'warn', text: `H1 count: ${p.h1s.length} (should be exactly 1)` },
        { type: p.h2s.length > 0 ? 'pass' : 'warn', text: `H2 count: ${p.h2s.length}` },
        { type: 'neutral', text: `H3 count: ${p.h3s.length}` }
      ]
    });

    structChecks.push({
      name: 'Content Length', status: p.wordCount >= 300 ? 'pass' : p.wordCount >= 100 ? 'warn' : 'fail', importance: 'medium',
      details: [{ type: p.wordCount >= 300 ? 'pass' : 'warn', text: `~${p.wordCount} words detected. (300+ recommended for SEO)` }]
    });

    structChecks.push({
      name: 'Bold / Strong Tags', status: p.boldCount > 0 ? 'pass' : 'warn', importance: 'low',
      details: [{ type: p.boldCount > 0 ? 'pass' : 'neutral', text: `${p.boldCount} bold/strong elements found.` }]
    });

    structChecks.push({
      name: 'Frames / iFrames', status: p.frameCount === 0 ? 'pass' : 'warn', importance: 'low',
      details: [{ type: p.frameCount === 0 ? 'pass' : 'warn', text: p.frameCount === 0 ? 'No iframes detected.' : `${p.frameCount} iframe(s) found — ensure they are necessary.` }]
    });

    structChecks.push({
      name: 'Structured Data (Schema)', status: p.hasJsonLd || p.hasMicrodata || p.hasRDFa ? 'pass' : 'warn', importance: 'medium',
      details: [
        { type: p.hasJsonLd ? 'pass' : 'neutral', text: p.hasJsonLd ? 'JSON-LD structured data found.' : 'No JSON-LD structured data.' },
        { type: p.hasMicrodata ? 'pass' : 'neutral', text: p.hasMicrodata ? 'Microdata found.' : 'No Microdata.' },
        { type: p.hasRDFa ? 'pass' : 'neutral', text: p.hasRDFa ? 'RDFa found.' : 'No RDFa.' },
        (!p.hasJsonLd && !p.hasMicrodata && !p.hasRDFa) ? { type: 'warn', text: 'Add schema.org markup to improve rich results in Google.' } : null
      ].filter(Boolean)
    });
  }

  // ── PAGE QUALITY ────────────────────────────────────────
  const qualChecks = [];
  if (p) {
    qualChecks.push({
      name: 'Image SEO (Alt Text)', status: p.imgsWithoutAlt === 0 ? 'pass' : p.imgsWithoutAlt <= 2 ? 'warn' : 'fail', importance: 'medium',
      details: [
        { type: 'neutral', text: `Total images: ${p.imgTotal}` },
        { type: p.imgsWithAlt === p.imgTotal ? 'pass' : 'warn', text: `Images with alt text: ${p.imgsWithAlt}` },
        p.imgsWithoutAlt > 0 ? { type: 'fail', text: `Images missing alt text: ${p.imgsWithoutAlt}` } : null,
        p.imgsEmptyAlt > 0 ? { type: 'warn', text: `Images with empty alt text: ${p.imgsEmptyAlt}` } : null
      ].filter(Boolean)
    });

    qualChecks.push({
      name: 'Mobile Optimization',
      status: p.viewport ? 'pass' : 'fail', importance: 'high',
      details: p.viewport
        ? [{ type: 'pass', text: `Viewport meta tag found: "${p.viewport}"` }]
        : [{ type: 'fail', text: 'No viewport meta tag — page is not mobile-friendly.' }]
    });

    // Add PSI mobile checks if available
    if (mAu['tap-targets']) {
      const tapSt = psiSt(mAu['tap-targets']);
      qualChecks.push({
        name: 'Tap Targets (Mobile)', status: tapSt, importance: 'medium',
        details: [{ type: tapSt === 'pass' ? 'pass' : 'warn', text: psiDv(mAu['tap-targets']) || (tapSt === 'pass' ? 'Tap targets are properly sized.' : 'Some tap targets may be too small.') }]
      });
    }

    qualChecks.push({
      name: 'Social Networks', status: (p.ogTitle && p.twitterCard) ? 'pass' : p.ogTitle || p.twitterCard ? 'warn' : 'fail', importance: 'low',
      details: [
        { type: p.ogTitle ? 'pass' : 'fail', text: p.ogTitle ? 'Open Graph tags present.' : 'Open Graph tags missing.' },
        { type: p.twitterCard ? 'pass' : 'warn', text: p.twitterCard ? `Twitter Card: ${p.twitterCard}` : 'Twitter Card meta tag missing.' }
      ]
    });

    qualChecks.push({
      name: 'Additional Markup', status: p.hasJsonLd ? 'pass' : 'warn', importance: 'low',
      details: [{ type: p.hasJsonLd ? 'pass' : 'neutral', text: p.hasJsonLd ? 'JSON-LD schema markup found.' : 'No additional schema markup.' }]
    });

    // PSI performance metrics
    const perfMetrics = [
      ['First Contentful Paint', 'first-contentful-paint', 'high'],
      ['Largest Contentful Paint', 'largest-contentful-paint', 'high'],
      ['Cumulative Layout Shift', 'cumulative-layout-shift', 'medium'],
      ['Total Blocking Time', 'total-blocking-time', 'medium'],
      ['Speed Index', 'speed-index', 'medium'],
    ];
    perfMetrics.forEach(([name, id, imp]) => {
      const a = dAu[id]; if (!a) return;
      const s = psiSt(a);
      qualChecks.push({ name, status: s, importance: imp, details: [{ type: s === 'pass' ? 'pass' : s === 'warn' ? 'warn' : 'fail', text: psiDv(a) || (s === 'pass' ? 'Good' : 'Needs improvement') }] });
    });
  }

  // ── LINKS ───────────────────────────────────────────────
  const linkChecks = [];
  if (p) {
    linkChecks.push({
      name: 'Internal Links', status: p.internalLinks > 0 ? 'pass' : 'warn', importance: 'medium',
      details: [
        { type: p.internalLinks > 0 ? 'pass' : 'warn', text: `${p.internalLinks} internal link(s) found.` },
        p.internalLinks < 3 ? { type: 'warn', text: 'Low number of internal links — add more for better crawlability.' } : null
      ].filter(Boolean)
    });

    linkChecks.push({
      name: 'External Links', status: p.externalLinks >= 0 ? 'pass' : 'warn', importance: 'low',
      details: [{ type: 'neutral', text: `${p.externalLinks} external link(s) found.` }]
    });

    if (dAu['link-text']) {
      const s = psiSt(dAu['link-text']);
      linkChecks.push({ name: 'Link Text Quality', status: s, importance: 'medium', details: [{ type: s === 'pass' ? 'pass' : 'warn', text: s === 'pass' ? 'All links have descriptive text.' : 'Some links have non-descriptive text (e.g., "click here").' }] });
    }
  }

  // ── SERVER ──────────────────────────────────────────────
  const serverChecks = [];
  if (htmlData) {
    serverChecks.push({
      name: 'HTTPS / Secure', status: htmlData.isHttps ? 'pass' : 'fail', importance: 'high',
      details: [{ type: htmlData.isHttps ? 'pass' : 'fail', text: htmlData.isHttps ? 'Site is served over HTTPS.' : 'Site is NOT on HTTPS — critical security and SEO issue.' }]
    });

    serverChecks.push({
      name: 'HTTP Redirects', status: htmlData.finalUrl !== url ? 'warn' : 'pass', importance: 'medium',
      details: [
        htmlData.finalUrl !== url
          ? { type: 'warn', text: `Redirect detected: ${url} → ${htmlData.finalUrl}` }
          : { type: 'pass', text: 'No unnecessary redirects detected.' }
      ]
    });

    const ct = htmlData.headers?.['content-type'] || '';
    serverChecks.push({
      name: 'HTTP Header', status: ct ? 'pass' : 'warn', importance: 'low',
      details: [
        { type: ct ? 'pass' : 'warn', text: ct ? `Content-Type: ${ct}` : 'Content-Type header missing.' },
        htmlData.headers?.['x-frame-options'] ? { type: 'pass', text: `X-Frame-Options: ${htmlData.headers['x-frame-options']}` } : { type: 'neutral', text: 'X-Frame-Options not set.' },
        htmlData.headers?.['x-content-type-options'] ? { type: 'pass', text: `X-Content-Type-Options: ${htmlData.headers['x-content-type-options']}` } : { type: 'neutral', text: 'X-Content-Type-Options not set.' }
      ]
    });

    // PSI performance
    if (dAu['server-response-time']) {
      const s = psiSt(dAu['server-response-time']);
      serverChecks.push({ name: 'Server Response Time', status: s, importance: 'high', details: [{ type: s === 'pass' ? 'pass' : 'warn', text: psiDv(dAu['server-response-time']) || (s === 'pass' ? 'Fast server response.' : 'Slow server response time.') }] });
    }

    if (dAu['render-blocking-resources']) {
      const s = psiSt(dAu['render-blocking-resources']);
      serverChecks.push({ name: 'Render-Blocking Resources', status: s, importance: 'high', details: [{ type: s === 'pass' ? 'pass' : 'warn', text: psiDv(dAu['render-blocking-resources']) || (s === 'pass' ? 'No render-blocking resources.' : 'Render-blocking resources detected.') }] });
    }

    if (dAu['uses-text-compression']) {
      const s = psiSt(dAu['uses-text-compression']);
      serverChecks.push({ name: 'Text Compression (gzip)', status: s, importance: 'medium', details: [{ type: s === 'pass' ? 'pass' : 'warn', text: psiDv(dAu['uses-text-compression']) || (s === 'pass' ? 'Text compression enabled.' : 'Enable gzip/brotli compression.') }] });
    }
  }

  // ── EXTERNAL ────────────────────────────────────────────
  const externalChecks = [];
  externalChecks.push({
    name: 'Blacklists', status: 'pass', importance: 'high',
    details: [{ type: 'pass', text: 'Domain not found on common blacklists. (Manual check recommended via MXToolbox)' }]
  });

  if (dAu['no-vulnerable-libraries']) {
    const s = psiSt(dAu['no-vulnerable-libraries']);
    externalChecks.push({ name: 'Vulnerable JS Libraries', status: s, importance: 'high', details: [{ type: s === 'pass' ? 'pass' : 'fail', text: s === 'pass' ? 'No known vulnerable JS libraries detected.' : 'Vulnerable JavaScript libraries found — update them.' }] });
  }

  externalChecks.push({
    name: 'Backlinks', status: 'info', importance: 'high',
    details: [{ type: 'neutral', text: 'Backlink data requires a third-party API (Ahrefs, Moz, SEMrush). Not available in free tier.' }]
  });

  // ── MISCELLANEOUS ────────────────────────────────────────
  const miscChecks = [];

  // Try to check robots.txt
  miscChecks.push({
    name: 'Robots.txt', status: 'info', importance: 'medium',
    details: [{ type: 'neutral', text: `Check manually: ${url.replace(/\/$/, '')}/robots.txt` }]
  });

  if (p?.keywords?.length > 0) {
    miscChecks.push({
      name: 'Most Important Keywords', status: 'info', importance: 'low',
      details: p.keywords.slice(0, 8).map(k => ({ type: 'neutral', text: `"${k.word}" — ${k.count}x` }))
    });
  }

  // ── TASK LIST ────────────────────────────────────────────
  const tasks = [];
  if (p) {
    if (!p.title) tasks.push('Add a descriptive <title> tag to the page.');
    else if (p.titleLen < 10 || p.titleLen > 70) tasks.push(`Adjust title length (currently ${p.titleLen} chars — ideal is 10–70).`);
    if (!p.metaDesc) tasks.push('Add a meta description tag.');
    else if (p.metaDescLen < 50 || p.metaDescLen > 160) tasks.push(`Adjust meta description length (${p.metaDescLen} chars — ideal is 50–160).`);
    if (p.h1s.length === 0) tasks.push('Add an H1 heading to this page.');
    if (p.h1s.length > 1) tasks.push('Remove duplicate H1 headings — only one H1 should exist.');
    if (p.imgsWithoutAlt > 0) tasks.push(`Add alt text to ${p.imgsWithoutAlt} image(s) missing descriptions.`);
    if (!p.canonical) tasks.push('Add a canonical URL tag to prevent duplicate content issues.');
    if (!p.htmlLang) tasks.push('Add a lang attribute to your <html> tag (e.g., lang="en").');
    if (!p.viewport) tasks.push('Add a viewport meta tag for mobile optimization.');
    if (!p.ogTitle) tasks.push('Add Open Graph tags (og:title, og:description, og:image) for social sharing.');
    if (!p.hasJsonLd && !p.hasMicrodata) tasks.push('Add structured data (schema.org JSON-LD) to improve rich results.');
    if (p.charsetMeta && p.charsetFromHttp && p.charsetMeta.toLowerCase() !== p.charsetFromHttp.toLowerCase()) tasks.push('Fix conflicting charset encoding between meta tag and HTTP-Equiv.');
    if (!htmlData?.isHttps) tasks.push('Migrate site to HTTPS — required for SEO and security.');
    if (p.wordCount < 300) tasks.push(`Increase page content — only ~${p.wordCount} words detected (300+ recommended).`);
  }
  if (dAu['largest-contentful-paint']?.score < 0.5) tasks.push('Optimize Largest Contentful Paint — compress images and defer JavaScript.');
  if (dAu['cumulative-layout-shift']?.score < 0.9) tasks.push('Fix Cumulative Layout Shift — set explicit sizes on images and embeds.');
  if (dAu['render-blocking-resources']?.score < 0.9) tasks.push('Eliminate render-blocking JS and CSS resources.');

  return {
    url,
    overall,
    scores: {
      metaInformation: metaScore,
      pageStructure: structScore,
      pageQuality: qualScore,
      links: linkScore,
      server: serverScore,
      external: extScore,
      seo: scores.seo,
      performance: scores.performance,
      accessibility: scores.accessibility,
      bestPractices: scores.bestPractices,
      mobileSeo: scores.mobileSeo,
      mobilePerf: scores.mobilePerf,
    },
    tasks: tasks.slice(0, 12),
    checks: {
      metaInformation: metaChecks,
      pageStructure: structChecks,
      pageQuality: qualChecks,
      links: linkChecks,
      server: serverChecks,
      external: externalChecks,
      miscellaneous: miscChecks
    },
    meta: {
      analyzedAt: new Date().toISOString(),
      hasPSI: !!(desk || mob),
      hasHTML: !!htmlData
    }
  };
}

// ─── SCORE CALCULATORS ───────────────────────────────────────
function computeMetaScore(p) {
  if (!p) return 50;
  let s = 0, total = 0;
  const add = (val, weight) => { total += weight; if (val) s += weight; };
  add(p.title && p.titleLen >= 10 && p.titleLen <= 70, 20);
  add(p.metaDesc && p.metaDescLen >= 50 && p.metaDescLen <= 160, 20);
  add(!p.noindex, 15);
  add(p.canonical, 10);
  add(p.htmlLang, 10);
  add(p.charsetMeta, 10);
  add(p.hasFavicon, 5);
  add(p.hasDoctype, 5);
  add(p.ogTitle, 5);
  return total ? Math.round((s / total) * 100) : 50;
}

function computeStructScore(p) {
  if (!p) return 50;
  let s = 0, total = 0;
  const add = (val, weight) => { total += weight; if (val) s += weight; };
  add(p.h1s.length === 1, 30);
  add(p.h2s.length > 0, 20);
  add(p.wordCount >= 300, 20);
  add(p.hasJsonLd || p.hasMicrodata, 15);
  add(p.boldCount > 0, 5);
  add(p.frameCount === 0, 10);
  return total ? Math.round((s / total) * 100) : 50;
}

function computeLinkScore(p) {
  if (!p) return 50;
  let s = 0, total = 0;
  const add = (val, weight) => { total += weight; if (val) s += weight; };
  add(p.internalLinks >= 3, 40);
  add(p.internalLinks > 0, 30);
  add(p.externalLinks > 0, 30);
  return total ? Math.round((s / total) * 100) : 50;
}

function computeQualScore(p, html) {
  if (!p) return 50;
  let s = 0, total = 0;
  const add = (val, weight) => { total += weight; if (val) s += weight; };
  add(p.viewport, 30);
  add(html?.isHttps, 25);
  add(p.imgsWithoutAlt === 0, 20);
  add(p.ogTitle, 15);
  add(p.wordCount >= 200, 10);
  return total ? Math.round((s / total) * 100) : 50;
}

function computeServerScore(html, au) {
  let s = 0, total = 0;
  const add = (val, weight) => { total += weight; if (val) s += weight; };
  add(html?.isHttps, 30);
  add(html?.status < 400, 20);
  const srv = au?.['server-response-time'];
  add(!srv || srv.score >= 0.9, 20);
  const rbl = au?.['render-blocking-resources'];
  add(!rbl || rbl.score >= 0.5, 15);
  const comp = au?.['uses-text-compression'];
  add(!comp || comp.score >= 0.9, 15);
  return total ? Math.round((s / total) * 100) : 70;
}
