/*
 * Shared API guards: SSRF-safe URL validation + per-IP rate limiting.
 * Files in /api starting with "_" are helper modules, not endpoints.
 */
const dns = require('dns').promises;
const net = require('net');

const SUPA_URL = 'https://jjfojqvhcecyxmstpmxl.supabase.co';
const SUPA_KEY = 'sb_publishable_631aiLjc7Kyv1bSNeNSYDg_xbuMdDCD';

// ── SSRF protection ────────────────────────────────────────────────
function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function inRange(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (~0 << (32 - +bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}
const BLOCKED_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15',
  '224.0.0.0/4', '240.0.0.0/4'
];
function isPrivateIP(ip) {
  if (net.isIPv4(ip)) return BLOCKED_V4.some(c => inRange(ip, c));
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd')) return true;      // unique local
    if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true; // link-local
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);           // IPv4-mapped
    if (mapped) return isPrivateIP(mapped[1]);
    return false;
  }
  return true; // unknown format → block
}

/**
 * Resolves the host and rejects URLs that point at internal/private/reserved
 * addresses. Throws Error with .code='SSRF' or .code='BAD_URL'.
 * Returns the validated URL string (normalized with protocol).
 */
async function validatePublicUrl(input) {
  let u = (input || '').trim();
  if (!u) { const e = new Error('URL is required.'); e.code = 'BAD_URL'; throw e; }
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  let parsed;
  try { parsed = new URL(u); } catch (_) { const e = new Error('Invalid URL.'); e.code = 'BAD_URL'; throw e; }
  if (!/^https?:$/.test(parsed.protocol)) { const e = new Error('Only http(s) URLs are allowed.'); e.code = 'BAD_URL'; throw e; }

  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host.endsWith('.lan') || host === 'metadata.google.internal') {
    const e = new Error('That host is not allowed.'); e.code = 'SSRF'; throw e;
  }
  // If the host is a literal IP, check it directly; otherwise resolve it.
  let addrs;
  if (net.isIP(host)) {
    addrs = [host];
  } else {
    try {
      const recs = await dns.lookup(host, { all: true });
      addrs = recs.map(r => r.address);
    } catch (_) { const e = new Error('Could not resolve that host.'); e.code = 'BAD_URL'; throw e; }
  }
  if (!addrs.length || addrs.some(isPrivateIP)) {
    const e = new Error('That host resolves to a private or internal address and cannot be scanned.'); e.code = 'SSRF'; throw e;
  }
  return u;
}

// ── rate limiting ──────────────────────────────────────────────────
function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

/**
 * Returns { ok: true } or { ok: false, retryAfter }. Fails open (allows) if the
 * limiter backend is unreachable, so a Supabase blip never takes the tools down.
 */
async function rateLimit(req, endpoint, limit = 20, windowSec = 60) {
  const key = 'rl:' + endpoint + ':' + clientIp(req);
  try {
    const res = await fetch(SUPA_URL + '/rest/v1/rpc/rl_hit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY },
      body: JSON.stringify({ p_key: key, p_limit: limit, p_window: windowSec })
    });
    if (!res.ok) return { ok: true };
    const allowed = await res.json();
    return allowed === true ? { ok: true } : { ok: false, retryAfter: windowSec };
  } catch (_) {
    return { ok: true };
  }
}

module.exports = { validatePublicUrl, rateLimit, isPrivateIP };
