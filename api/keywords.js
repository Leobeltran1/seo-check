const https = require('https');
const { URL } = require('url');
const { rateLimit, cacheGet, cacheSet } = require('./_guard.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rl = await rateLimit(req, 'keywords', 15, 60);
  if (!rl.ok) { res.setHeader('Retry-After', rl.retryAfter); return res.status(429).json({ error: 'Too many requests — please wait a minute and try again.' }); }

  const { keyword } = req.query;
  const key = process.env.SERPAPI_KEY;

  if (!keyword) return res.status(400).json({ error: 'Keyword is required.' });
  if (!key) return res.status(500).json({ error: 'Search API not configured on server.' });

  const ck = 'kws:' + keyword.toLowerCase();
  const hit = await cacheGet(ck);
  if (hit) return res.status(200).json(Object.assign(hit, { cached: true }));

  try {
    const [related, questions] = await Promise.all([
      fetchSERP(`${keyword}`, key),
      fetchSERP(`${keyword} how`, key),
    ]);

    const suggestions = extractSuggestions(related, keyword);
    const questionList = extractQuestions(questions, keyword);
    const relatedSearches = extractRelated(related);
    const metrics = estimateMetrics(related, keyword);

    const result = { keyword, suggestions, questions: questionList, relatedSearches, metrics };
    await cacheSet(ck, result, 86400); // 24h
    res.status(200).json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};

function fetchSERP(keyword, key) {
  return new Promise((resolve, reject) => {
    const searchUrl = `https://serpapi.com/search.json?q=${encodeURIComponent(keyword)}&api_key=${encodeURIComponent(key)}&num=10&engine=google`;
    const parsed = new URL(searchUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: 15000,
    };
    const req = https.request(options, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (data.error) return reject(new Error(data.error));
          resolve(data);
        } catch(e) { reject(new Error('Failed to parse results')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

function extractSuggestions(data, keyword) {
  const suggestions = new Set();
  if (data.related_searches) {
    data.related_searches.forEach(r => suggestions.add(r.query));
  }
  if (data.organic_results) {
    data.organic_results.forEach(r => {
      if (r.title) {
        const words = r.title.toLowerCase().split(/\s+/);
        const kwords = keyword.toLowerCase().split(/\s+/);
        if (kwords.some(k => words.includes(k))) suggestions.add(r.title.slice(0, 60));
      }
    });
  }
  return [...suggestions].slice(0, 12);
}

function extractQuestions(data, keyword) {
  const questions = new Set();
  if (data.related_questions) {
    data.related_questions.forEach(q => questions.add(q.question));
  }
  if (data.organic_results) {
    data.organic_results.forEach(r => {
      if (r.title && /^(how|what|why|when|where|which|who|is|are|can|do|does)/i.test(r.title)) {
        questions.add(r.title);
      }
    });
  }
  return [...questions].slice(0, 8);
}

function extractRelated(data) {
  if (!data.related_searches) return [];
  return data.related_searches.slice(0, 8).map(r => r.query);
}

function estimateMetrics(data, keyword) {
  const totalResults = parseInt(data.search_information?.total_results || 0);
  const searchTime = data.search_information?.time_taken_displayed || '0';
  const resultCount = data.organic_results?.length || 0;
  const hasAds = (data.ads?.length || 0) > 0;
  const competition = hasAds ? 'High' : totalResults > 100000000 ? 'Medium' : 'Low';
  const competitionColor = competition === 'High' ? '#e74c3c' : competition === 'Medium' ? '#f0a500' : '#27ae60';
  const difficulty = hasAds ? 75 : totalResults > 500000000 ? 65 : totalResults > 100000000 ? 45 : 25;
  return { totalResults, searchTime, competition, competitionColor, difficulty, hasAds };
}
