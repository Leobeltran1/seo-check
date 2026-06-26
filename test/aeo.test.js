const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../api/aeo.js')._test;

const richHtml = `<!DOCTYPE html><html><head>
  <title>Complete Guide to Fiber Optic Cabling</title>
  <meta name="description" content="Everything you need to know about fiber optic cabling, costs, and installation in one comprehensive guide.">
  <meta property="og:title" content="x"><meta property="og:image" content="https://x.com/a.png">
  <link rel="canonical" href="https://x.com/guide">
  <script type="application/ld+json">{"@type":"FAQPage"}</script>
  <script type="application/ld+json">{"@type":"Article","author":{"@type":"Person","name":"Jane"},"datePublished":"2026-01-01"}</script>
  <script type="application/ld+json">{"@type":"WebSite","name":"X"}</script>
</head><body>
  <h1>Fiber Optic Cabling Guide</h1>
  <h2>What is fiber optic cabling?</h2><p>${'Fiber optic cabling uses light to transmit data. '.repeat(20)}</p>
  <h2>How much does it cost?</h2><p>${'Costs vary by length and type. '.repeat(20)}</p>
  <ul><li>single mode</li><li>multi mode</li></ul>
  <table><tr><td>a</td></tr></table>
  <a href="https://en.wikipedia.org/wiki/Optical_fiber">source</a>
  <time datetime="2026-01-01">Jan 2026</time>
</body></html>`;

const bareHtml = `<html><head><title>x</title></head><body><h1>Hi</h1><p>short</p></body></html>`;

test('rich, well-structured page scores high overall', () => {
  const r = analyze({ html: richHtml, finalUrl: 'https://x.com/guide' }, null, null);
  assert.ok(r.overall >= 70, 'expected >=70, got ' + r.overall);
  assert.ok(r.scores.structuredData >= 80, 'structuredData ' + r.scores.structuredData);
  assert.ok(r.scores.answerContent >= 60, 'answerContent ' + r.scores.answerContent);
});

test('thin bare page scores low and lists fixes', () => {
  const r = analyze({ html: bareHtml, finalUrl: 'https://x.com' }, null, null);
  assert.ok(r.overall < 45, 'expected <45, got ' + r.overall);
  assert.ok(r.tasks.length > 0);
});

test('detects AI crawler blocks from robots.txt', () => {
  const robots = 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /';
  const r = analyze({ html: richHtml, finalUrl: 'https://x.com/guide' }, robots, null);
  assert.ok(r.stats.blockedBots.includes('gptbot'), 'should flag gptbot block');
});

test('detects llms.txt presence', () => {
  const r = analyze({ html: richHtml, finalUrl: 'https://x.com/guide' }, null, '# llms\nsome content');
  assert.equal(r.stats.hasLlmsTxt, true);
});
