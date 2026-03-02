// api/daily.js — Vercel Serverless Function
// Fetches today's top Guardian story and has Gemini summarize it.
// Responses are cached by date so everyone gets the same daily story.

const GUARDIAN_KEY = process.env.GUARDIAN_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

// Simple in-memory cache (lives for the duration of the serverless instance)
let cache = { date: null, article: null };

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "2026-03-02"
}

async function fetchGuardianArticle() {
  const today = todayKey();
  const url = `https://content.guardianapis.com/search?` + new URLSearchParams({
    'api-key': GUARDIAN_KEY,
    'section': 'world|us-news|politics|technology|science',
    'show-fields': 'trailText,bodyText,headline,shortUrl,thumbnail',
    'order-by': 'relevance',
    'page-size': '10',
    'from-date': today,
    'to-date': today,
    'lang': 'en',
  });

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Guardian API error: ${res.status}`);
  const data = await res.json();

  const results = data?.response?.results;
  if (!results || results.length === 0) {
    // Fallback: get yesterday's top story
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yd = yesterday.toISOString().slice(0, 10);
    const fallbackUrl = `https://content.guardianapis.com/search?` + new URLSearchParams({
      'api-key': GUARDIAN_KEY,
      'section': 'world|us-news|politics|technology|science',
      'show-fields': 'trailText,bodyText,headline,shortUrl,thumbnail',
      'order-by': 'relevance',
      'page-size': '10',
      'from-date': yd,
      'to-date': yd,
      'lang': 'en',
    });
    const fb = await fetch(fallbackUrl);
    const fbData = await fb.json();
    const fbResults = fbData?.response?.results;
    if (!fbResults || fbResults.length === 0) throw new Error('No articles found');
    return fbResults[0];
  }

  return results.find(r => r.fields?.bodyText?.length > 200) || results[0];
}

async function summarizeWithGemini(article) {
  const rawText = (article.fields?.bodyText || article.fields?.trailText || '').slice(0, 3000);
  const realHeadline = article.fields?.headline || article.webTitle || '';
  const publishedDate = article.webPublicationDate?.slice(0, 10) || todayKey();

  const prompt = `You are a news editor preparing a daily headline-writing game.

Here is a real news article:

HEADLINE: ${realHeadline}
BODY: ${rawText}

Your job:
1. Write a neutral, informative SYNOPSIS of 3-4 sentences that tells players what happened — enough to write a headline — but does NOT reveal the real headline's exact wording.
2. Extract 8-10 relevant KEYWORDS from the article (lowercase, single words or short phrases).

Respond ONLY with this exact JSON (no markdown, no explanation):
{"synopsis":"3-4 sentence summary here.","keywords":["word1","word2","word3","word4","word5","word6","word7","word8"],"publishedDate":"${publishedDate}","source":"The Guardian"}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 1000 },
      }),
    }
  );

  if (!res.ok) throw new Error(`Gemini error: ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const clean = text.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
    else throw new Error('Failed to parse Gemini response');
  }

  return {
    id: article.id || todayKey(),
    date: parsed.publishedDate,
    source: 'The Guardian',
    synopsis: parsed.synopsis,
    realHeadline: realHeadline,
    keywords: parsed.keywords || [],
    url: article.webUrl || '',
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const today = todayKey();

    if (cache.date === today && cache.article) {
      return res.status(200).json({ ...cache.article, cached: true });
    }

    const guardianArticle = await fetchGuardianArticle();
    const article = await summarizeWithGemini(guardianArticle);

    cache = { date: today, article };

    return res.status(200).json(article);
  } catch (err) {
    console.error('Daily article error:', err);
    return res.status(500).json({ error: err.message });
  }
}
