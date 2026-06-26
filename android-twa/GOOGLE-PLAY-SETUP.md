# SEO Rocket — Google Play (TWA) Packaging

This wraps the existing PWA (live at **https://seo-check-flax.vercel.app**) in a
**Trusted Web Activity** so it can ship on the Google Play Store. A TWA is a thin
Android shell that opens the live site full-screen with no browser UI — so the
app always reflects what's deployed; no separate mobile codebase.

> Status: **build verified.** The full toolchain is installed (JDK 17, Android
> SDK build-tools 34 / platform-34, Bubblewrap CLI — `bubblewrap doctor` passes),
> and a test build succeeded: it produced a valid signed `app-release-bundle.aab`
> (package `ai.seorocket.app`, label "SEO Rocket"). That test build used a
> **throwaway dev key** (`android.keystore`, gitignored) — fine for proving the
> pipeline, **not** for Play. The real submission needs a Google Play Developer
> account + your own upload key (steps below). Nothing has been submitted.

## Toolchain (already installed on this machine)
- JDK 17: `/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk`
- Android SDK: `/opt/homebrew/share/android-commandlinetools` (build-tools 34.0.0, platform android-34)
- Bubblewrap config: `~/.bubblewrap/config.json` (points at both; `bubblewrap doctor` ✓)
- The generated Gradle project + build outputs + keystore are **gitignored** (regenerated from `twa-manifest.json` on each build).

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

## Build steps (run these in a real Terminal — Bubblewrap is interactive)
From the `android-twa/` folder:

1. **Create your real upload key** (replaces the throwaway dev key). Choose a
   password and keep it safe:
   ```
   rm -f android.keystore
   /opt/homebrew/opt/openjdk@17/bin/keytool -genkeypair -keystore android.keystore \
     -alias seorocket -keyalg RSA -keysize 2048 -validity 10000 \
     -dname "CN=SEO Rocket, O=Titan Companies, C=US"
   ```
2. **Build the release bundle:**
   ```
   bubblewrap build
   ```
   Enter your keystore password when prompted. Produces
   `app-release-bundle.aab` (upload this to Play) and `app-release-signed.apk`
   (sideload to test on a phone). The toolchain is already installed, so this
   just builds.

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

5. **Submit:** in Play Console → create app → upload `app-release-bundle.aab`,
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
