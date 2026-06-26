const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../api/schema.js')._test;

const html = `<html><head>
  <title>DNS FAQ</title>
  <meta name="description" content="Common DNS questions answered.">
  <meta property="og:site_name" content="ExampleCo">
</head><body>
  <h1>DNS</h1>
  <h2>What is DNS?</h2><p>DNS is the phonebook of the internet that maps domain names to IP addresses for routing.</p>
  <h2>How does DNS work?</h2><p>A resolver queries a chain of servers to translate a hostname into an address.</p>
  <h2>Pricing</h2><p>This is not a question heading and should be ignored for FAQ.</p>
  <a href="https://twitter.com/exampleco">x</a>
</body></html>`;

test('extracts FAQ pairs from question headings', () => {
  const r = build({ html, finalUrl: 'https://example.com/dns' });
  assert.equal(r.faqCount, 2, 'expected 2 FAQs, got ' + r.faqCount);
  assert.ok(r.schemas.faq.includes('What is DNS?'));
  assert.ok(r.schemas.faq.includes('phonebook of the internet'));
});

test('produces valid JSON-LD for FAQ', () => {
  const r = build({ html, finalUrl: 'https://example.com/dns' });
  const json = JSON.parse(r.schemas.faq.replace(/<\/?script[^>]*>/g, ''));
  assert.equal(json['@type'], 'FAQPage');
  assert.equal(json.mainEntity.length, 2);
  assert.equal(json.mainEntity[0].acceptedAnswer['@type'], 'Answer');
});

test('generates Article + Organization with detected metadata', () => {
  const r = build({ html, finalUrl: 'https://example.com/dns' });
  const org = JSON.parse(r.schemas.organization.replace(/<\/?script[^>]*>/g, ''));
  assert.equal(org['@type'], 'Organization');
  assert.equal(org.name, 'ExampleCo');
  assert.ok(Array.isArray(org.sameAs) && org.sameAs[0].includes('twitter.com'));
  assert.ok(r.schemas.article.includes('DNS FAQ'));
});

test('ignores non-question headings', () => {
  const r = build({ html, finalUrl: 'https://example.com/dns' });
  assert.ok(!r.schemas.faq.includes('Pricing'));
});
