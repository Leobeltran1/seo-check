# Email Reports (weekly digest + rank-drop alerts)

Sends opted-in users a weekly summary of their tracked keyword positions
(with ▲/▼ change vs last check) and recent audits, and flags any keywords that
dropped. Built on `api/email-cron.js`. Uses [Resend](https://resend.com) to send.

## Status
- **Built and ready** — including a per-user opt-out toggle in Profile
  (`profiles.email_reports`, on by default; backfilled for existing users via a
  signup trigger).
- **Preview it now (no setup):**
  `https://seo-check-flax.vercel.app/api/email-cron?dry=1` renders a sample
  digest as HTML so you can see the design before turning it on.
- **Not scheduled and not sending** until the keys below are set.

## Enabling (activate-with-a-key)
1. Create a **Resend** account, verify a sending domain (e.g. `seo-rocket.ai`)
   or use Resend's test domain to start.
2. Set Vercel env vars (Production):
   - `RESEND_API_KEY` — from Resend.
   - `EMAIL_FROM` — e.g. `SEO Rocket <reports@seo-rocket.ai>` (must be on the
     verified domain; defaults to Resend's `onboarding@resend.dev` for testing).
   - `SUPABASE_SERVICE_KEY` — Supabase service-role key (to read all opted-in
     users). Same key the rank-tracking cron uses.
3. Add the weekly schedule to `vercel.json` `crons`:
   ```json
   { "path": "/api/email-cron", "schedule": "0 13 * * 1" }
   ```
   (Mondays 13:00 UTC. Pair with the daily `track-cron` so positions are fresh.)
4. Redeploy.

Until `RESEND_API_KEY` is set, `/api/email-cron` safely no-ops (returns a
"disabled" JSON). Users who toggle reports off in Profile are skipped.

## Notes
- Rank-drop detection compares each keyword's latest position to its previous
  `rank_history` entry — so it's only meaningful once `track-cron` (or manual
  refreshes) have produced 2+ data points.
- Keep the send cadence and tracked-keyword volume in mind: emails are cheap, but
  the daily rank checks that feed them cost SerpAPI credits.
