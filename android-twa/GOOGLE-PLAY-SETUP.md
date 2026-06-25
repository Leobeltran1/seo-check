# SEO Rocket — Google Play (TWA) Packaging

This wraps the existing PWA (live at **https://seo-check-flax.vercel.app**) in a
**Trusted Web Activity** so it can ship on the Google Play Store. A TWA is a thin
Android shell that opens the live site full-screen with no browser UI — so the
app always reflects what's deployed; no separate mobile codebase.

> Status: **scaffold only.** The project config and Digital Asset Links file are
> in place. Producing and submitting the signed bundle still needs the
> prerequisites below (a Google Play Developer account + generating a signing
> key). Nothing here has been submitted.

## What's already in the repo
- `android-twa/twa-manifest.json` — Bubblewrap project config (name, colors,
  icons, package id `ai.seorocket.app`, wrapped host).
- `public/.well-known/assetlinks.json` — Digital Asset Links file, served at
  `https://seo-check-flax.vercel.app/.well-known/assetlinks.json`. The SHA-256
  fingerprint is a **placeholder** — it gets filled in after the signing key
  exists (step 3).

## Prerequisites (one-time)
1. **Google Play Developer account** — $25 one-time, at
   https://play.google.com/console (needed only to actually publish).
2. **Java JDK 17+** — `brew install openjdk@17`
3. **Bubblewrap CLI** — `npm i -g @bubblewrap/cli`
   (On first `build`, Bubblewrap offers to install the Android SDK for you.)

## Build steps
From the `android-twa/` folder:

1. **Initialize / build** (uses the existing twa-manifest.json):
   ```
   bubblewrap build
   ```
   First run prompts to create a **signing key** — accept, and save the keystore
   password somewhere safe (you cannot update the app later without it). This
   produces `app-release-signed.aab` (for Play) and `app-release-signed.apk`
   (for local testing).

2. **Get the signing key fingerprint:**
   ```
   bubblewrap fingerprint list
   ```
   Copy the **SHA-256** value.

3. **Fill in Digital Asset Links:** paste that SHA-256 into
   `public/.well-known/assetlinks.json` (replace the placeholder), then commit +
   deploy so it's live. Verify:
   ```
   curl https://seo-check-flax.vercel.app/.well-known/assetlinks.json
   ```
   This is what removes the browser URL bar and makes it a true full-screen app.

4. **Test the APK** on a device/emulator:
   ```
   bubblewrap install
   ```

5. **Submit:** in Play Console → create app → upload `app-release-signed.aab`,
   fill in store listing (icon, screenshots, description, privacy policy URL),
   and roll out to internal testing first.

## Notes
- **Package id `ai.seorocket.app` is permanent** once published — pick the final
  brand id before the first submission if you want something else.
- **Domain move:** the app currently wraps `seo-check-flax.vercel.app`. If you
  later move to `seo-rocket.net`/`.ai`, update `host`/`startUrl`/`webManifestUrl`
  in twa-manifest.json, place the same assetlinks.json on that domain, and
  rebuild. Easiest to wait until the final domain is live before first publish.
- Play now requires a **privacy policy URL** and a data-safety form — worth
  preparing since the app has accounts/login.
