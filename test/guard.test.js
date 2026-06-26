const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateIP, validatePublicUrl } = require('../api/_guard.js');

test('isPrivateIP flags private/reserved IPv4', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '198.18.0.1']) {
    assert.equal(isPrivateIP(ip), true, ip + ' should be private');
  }
});

test('isPrivateIP allows public IPv4', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34']) {
    assert.equal(isPrivateIP(ip), false, ip + ' should be public');
  }
});

test('isPrivateIP flags IPv6 loopback / ULA / link-local', () => {
  for (const ip of ['::1', 'fc00::1', 'fd12:3456::1', 'fe80::1']) {
    assert.equal(isPrivateIP(ip), true, ip + ' should be private');
  }
  assert.equal(isPrivateIP('2606:4700:4700::1111'), false);
});

test('validatePublicUrl blocks localhost and internal hostnames', async () => {
  for (const u of ['http://localhost', 'http://foo.internal', 'http://metadata.google.internal']) {
    await assert.rejects(() => validatePublicUrl(u), e => e.code === 'SSRF');
  }
});

test('validatePublicUrl blocks private IP literals', async () => {
  for (const u of ['http://127.0.0.1', 'http://10.0.0.5/x', 'http://192.168.1.1', 'http://169.254.169.254/latest']) {
    await assert.rejects(() => validatePublicUrl(u), e => e.code === 'SSRF');
  }
});

test('validatePublicUrl rejects bad input / non-http protocols', async () => {
  await assert.rejects(() => validatePublicUrl(''), e => e.code === 'BAD_URL');
  await assert.rejects(() => validatePublicUrl('file:///etc/passwd'), e => Boolean(e.code));
});

test('validatePublicUrl allows a public IP literal and normalizes scheme', async () => {
  const out = await validatePublicUrl('1.1.1.1');
  assert.equal(out, 'https://1.1.1.1');
});
