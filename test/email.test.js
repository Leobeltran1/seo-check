const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assemble, renderDigest } = require('../api/email-cron.js')._test;

// history is newest-first (matches the order=checked_at.desc query)
const tracked = [
  { id: 'a', keyword: 'fiber miami', domain: 'a.com', last_position: 9 },   // was 6 → dropped 3
  { id: 'b', keyword: 'cabling tampa', domain: 'b.com', last_position: 2 }, // was 5 → improved 3
  { id: 'c', keyword: 'orlando net', domain: 'c.com', last_position: null } // not in top 10
];
const history = [
  { tracked_keyword_id: 'a', position: 9 }, { tracked_keyword_id: 'a', position: 6 },
  { tracked_keyword_id: 'b', position: 2 }, { tracked_keyword_id: 'b', position: 5 }
];

test('assemble computes change and detects drops', () => {
  const d = assemble(tracked, history, []);
  const a = d.rows.find(r => r.keyword === 'fiber miami');
  const b = d.rows.find(r => r.keyword === 'cabling tampa');
  assert.equal(a.change, -3, 'dropped keyword change');
  assert.equal(b.change, 3, 'improved keyword change');
  assert.equal(d.drops.length, 1);
  assert.equal(d.drops[0].keyword, 'fiber miami');
});

test('hasContent false when no keywords and no audits', () => {
  const d = assemble([], [], []);
  assert.equal(d.hasContent, false);
});

test('renderDigest subject reflects drops and renders rows', () => {
  const d = assemble(tracked, history, [{ url: 'https://b.com', overall_score: 80 }]);
  const out = renderDigest('leo', d);
  assert.match(out.subject, /dropped/);
  assert.ok(out.html.includes('fiber miami'));
  assert.ok(out.html.includes('Hi leo'));
  assert.ok(out.html.includes('▼'));  // drop badge
  assert.ok(out.html.includes('▲'));  // improvement badge
});

test('renderDigest no-drop subject when nothing dropped', () => {
  const d = assemble([tracked[1]], history.filter(h => h.tracked_keyword_id === 'b'), []);
  const out = renderDigest('leo', d);
  assert.doesNotMatch(out.subject, /dropped/);
});
