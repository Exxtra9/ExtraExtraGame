// api/judge.js — Vercel Serverless Function
// Securely calls Gemini API server-side so the API key is never exposed.

const GEMINI_KEY = process.env.GEMINI_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { headline, synopsis, realHeadline } = req.body;

  if (!headline || !synopsis || !realHeadline) {
    return res.status(400).json({ error: 'Missing required fields: headline, synopsis, realHeadline' });
  }

  if (headline.length > 200) {
    return res.status(400).json({ error: 'Headline too long' });
  }

  const prompt = `You are a seasoned newspaper editor judging a headline-writing game.

THE NEWS STORY SYNOPSIS (what players were shown):
${synopsis}

THE REAL PUBLISHED HEADLINE:
"${realHeadline}"

THE PLAYER'S SUBMITTED HEADLINE:
"${headline}"

Judge this headline on four criteria, each scored 0-25 (total 100 points):

1. CLARITY (0-25): Is it clear, concise, grammatically correct, and easy to understand at a glance?
2. ACCURACY (0-25): Does it correctly represent the key facts of the story? Penalize vague or misleading claims.
3. HOOK (0-25): Is it punchy, attention-grabbing, and would it make someone want to read more?
4. ORIGINALITY (0-25): Is it creative and meaningfully different from the real headline?
   - If the player's headline is more than 70% similar in wording to the real headline, cap originality at 5.
   - Reward clever angles, wordplay, or fresh framing.

Important: Be fair but honest. Don't inflate scores. A mediocre headline should score 40-55.

Respond ONLY with this exact JSON (no markdown, no preamble):
{"clarity":20,"accuracy":18,"hook":15,"originality":22,"verdict":"One or two sentences of editorial feedback in a witty, encouraging newspaper editor voice. Reference something specific about their headline.","totalScore":75}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.5, maxOutputTokens: 500 },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini error ${response.status}: ${err}`);
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error('Could not parse Gemini response');
    }

    // Clamp all scores
    parsed.clarity     = Math.min(25, Math.max(0, parseInt(parsed.clarity)     || 0));
    parsed.accuracy    = Math.min(25, Math.max(0, parseInt(parsed.accuracy)    || 0));
    parsed.hook        = Math.min(25, Math.max(0, parseInt(parsed.hook)        || 0));
    parsed.originality = Math.min(25, Math.max(0, parseInt(parsed.originality) || 0));
    parsed.totalScore  = parsed.clarity + parsed.accuracy + parsed.hook + parsed.originality;

    return res.status(200).json(parsed);
  } catch (err) {
    console.error('Judge error:', err);
    return res.status(500).json({ error: err.message });
  }
}
