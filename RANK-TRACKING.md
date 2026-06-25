# Rank Tracking

Logged-in users can track where a domain ranks on Google for a keyword and watch
the position over time.

## What's live now (no extra setup)
- **Rank Tracker** tab in the app (`/app.html`) — logged-in users add a
  `keyword + domain`, which immediately checks the current Google position
  (top-10, via SerpAPI) and starts a history.
- Each tracked keyword shows its latest position, a **sparkline** of its history,
  and **Refresh** (re-check now) / **Remove** buttons.
- Data lives in Supabase: `tracked_keywords` and `rank_history` (both RLS,
  owner-only). The user-driven flow needs no service key — it uses the user's
  own session.

## Enabling automatic daily refresh (optional, has cost)
`api/track-cron.js` re-checks every tracked keyword and appends to history. It is
**not scheduled by default** because each keyword = one SerpAPI call = cost.

To turn it on:
1. In Supabase → Project Settings → API, copy the **service_role** key.
2. Add it to Vercel: `vercel env add SUPABASE_SERVICE_KEY` (Production).
3. Add the schedule to `vercel.json` `crons`:
   ```json
   { "path": "/api/track-cron", "schedule": "0 9 * * *" }
   ```
4. Redeploy.

Until `SUPABASE_SERVICE_KEY` is set, hitting `/api/track-cron` safely no-ops.
Each run is capped at 100 keywords (`MAX_PER_RUN`) to bound cost/duration.

## Limitations / notes
- Positions are **top-10 only** (the keyword API requests `num=10`). A domain not
  in the top 10 shows as "Not in top 10". Tracking deeper would need a larger
  SerpAPI `num` (more cost).
- SerpAPI is metered — daily automated tracking across many users/keywords adds
  up. Consider gating automatic tracking behind a paid tier.
