# SEO Check

A full-stack SEO audit tool — enter any URL and get a complete report covering meta tags, headings, links, images, performance, and more.

## What it checks

- **Meta Information** — title tag, meta description, canonical URL, charset, language, Open Graph tags, hreflang, favicon, doctype
- **Page Structure** — H1/H2/H3 headings, content length, structured data (JSON-LD/schema), bold tags, iframes
- **Page Quality** — image alt text, mobile viewport, performance metrics (FCP, LCP, CLS, TBT)
- **Links** — internal links, external links, link text quality
- **Server** — HTTPS, HTTP redirects, response headers, render-blocking resources, text compression
- **External** — vulnerable JS libraries, blacklist check
- **Miscellaneous** — robots.txt, top keywords

## Tech Stack

- **Frontend** — Vanilla HTML/CSS/JS (`public/index.html`)
- **Backend** — Node.js serverless function (`api/analyze.js`)
- **Data sources** — HTML parsing (direct fetch) + Google PageSpeed Insights API
- **Hosting** — Vercel (free hobby tier)

## No paid API keys required

Everything is free:
- Google PageSpeed Insights — free, no key needed for basic use
- Vercel — free hobby tier
- node-fetch — open source

## Project Structure

```
seo-check/
├── api/
│   └── analyze.js       # Serverless backend — fetches HTML + calls PageSpeed
├── public/
│   └── index.html       # Frontend UI
├── vercel.json          # Vercel routing config
├── package.json         # Dependencies
└── README.md
```

## Deploy to Vercel

```bash
# Install Vercel CLI if you haven't
npm install -g vercel

# Clone your repo and deploy
git clone https://github.com/YOUR_USERNAME/seo-check
cd seo-check
vercel --prod
```

## Run locally

```bash
npm install
vercel dev
```

Then open `http://localhost:3000`

## Optional: Add a Google API Key

If you hit rate limits on PageSpeed Insights, get a free key at:
[console.cloud.google.com](https://console.cloud.google.com) → Enable **PageSpeed Insights API** → Create **API Key**

Then pass it as a query param: `/api/analyze?url=example.com&psiKey=YOUR_KEY`

Or hardcode it in `api/analyze.js` line where `psiKey` is read from query params.

## License

MIT — free to use, modify, and deploy.
