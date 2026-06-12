// Pinged daily by Vercel cron (see vercel.json) so the free-tier Supabase
// project never pauses from inactivity — a pause takes login and saving down.
const SUPA_URL = 'https://jjfojqvhcecyxmstpmxl.supabase.co';
const SUPA_KEY = 'sb_publishable_631aiLjc7Kyv1bSNeNSYDg_xbuMdDCD';

module.exports = async function handler(req, res) {
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/audits?select=id&limit=1', {
      headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY }
    });
    res.status(200).json({ ok: r.ok, status: r.status, at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
