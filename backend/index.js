import 'dotenv/config';
import express, { json } from "express";
import cors from "cors";

const app  = express();
const PORT = process.env.PORT || 3000;

// Config

/**
 * Groq API endpoint — do not change.
 * Groq uses an OpenAI-compatible API so the request format is identical.
 */
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

/**
 * Model to use. Free options on Groq:
 *   - "llama-3.1-8b-instant"   → fastest, great for summarization
 *   - "llama3-70b-8192"        → smarter, slightly slower
 *   - "mixtral-8x7b-32768"     → large context window (good for long pages)
 */
const AI_MODEL = process.env.AI_MODEL || "llama-3.1-8b-instant";

/**
 * Max tokens in the AI response.
 * 1024 is enough for structured JSON summaries.
 */
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "1024", 10);

/**
 * Simple rate limiting — max requests per IP per minute.
 * Keeps your free Groq quota safe.
 */
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "15", 10);
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute


// ─── Middleware ───────────────────────────────────────────────────────────────

// CORS — allow all origins so any extension can call this proxy.
// Tighten this with an allowlist if you want more security.
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

// Parse JSON bodies up to 1 MB
app.use(json({ limit: "1mb" }));

// ─── In-memory rate limiter ───────────────────────────────────────────────────
// Tracks { ip -> [timestamps] } — resets on server restart.
// For production you'd use Redis, but this works great for Render free tier.
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const timestamps = (rateLimitMap.get(ip) || []).filter(
    t => now - t < RATE_LIMIT_WINDOW_MS
  );

  if (timestamps.length >= RATE_LIMIT_MAX) {
    return false; // blocked
  }

  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return true; // allowed
}

// Clean up old entries every 5 minutes so memory doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimitMap) {
    const fresh = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) rateLimitMap.delete(ip);
    else rateLimitMap.set(ip, fresh);
  }
}, 5 * 60_000);


// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /
 * Health check — Render uses this to verify the service is alive.
 */
app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "AI Page Summarizer Proxy",
    model: AI_MODEL,
    timestamp: new Date().toISOString()
  });
});

/**
 * POST /summarize
 * Main endpoint. Accepts page content, calls Groq, returns structured summary.
 *
 * Request body:
 *   { content: string, title: string, summaryLength: "brief"|"standard"|"detailed" }
 *
 * Response:
 *   { summary, keyInsights, mainTopic, sentiment, readingTimeMinutes, wordCount, highlights }
 */
app.post("/summarize", async (req, res) => {
  // ── Rate limit check ───────────────────────────────────────────────────────
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim()
            || req.socket.remoteAddress
            || "unknown";

  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: "Too many requests. Please wait a moment and try again."
    });
  }

  // ── Validate API key exists ────────────────────────────────────────────────
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("GROQ_API_KEY environment variable is not set!");
    return res.status(500).json({
      error: "Proxy server is not configured. Contact the administrator."
    });
  }

  // ── Validate request body ──────────────────────────────────────────────────
  const { content, title, summaryLength } = req.body;

  if (!content || typeof content !== "string") {
    return res.status(400).json({ error: "Missing or invalid 'content' field." });
  }

  if (content.length < 50) {
    return res.status(400).json({ error: "Page content is too short to summarize." });
  }

  // ── Build prompt ───────────────────────────────────────────────────────────
  const prompt = buildPrompt(content, title || "Untitled Page", summaryLength || "standard");

  // ── Call Groq API ──────────────────────────────────────────────────────────
  let groqResponse;
  try {
    groqResponse = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0.3, // low = more consistent, structured output
        messages: [
          {
            role: "system",
            content: "You are an expert content analyst. You always respond with valid raw JSON only — no markdown, no code fences, no explanation. Just the JSON object."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });
  } catch (networkErr) {
    console.error("Network error calling Groq:", networkErr.message);
    return res.status(502).json({
      error: "Failed to reach AI service. Please try again."
    });
  }

  // ── Handle Groq error responses ────────────────────────────────────────────
  if (!groqResponse.ok) {
    const errorBody = await groqResponse.json().catch(() => ({}));
    const msg = errorBody?.error?.message || groqResponse.statusText;
    console.error(`Groq API error ${groqResponse.status}: ${msg}`);

    if (groqResponse.status === 429) {
      return res.status(429).json({ error: "AI service rate limit hit. Try again in a minute." });
    }

    return res.status(502).json({ error: `AI service error: ${msg}` });
  }

  // ── Parse Groq response ────────────────────────────────────────────────────
  const groqData = await groqResponse.json();
  const rawText  = groqData.choices?.[0]?.message?.content || "";

  // ── Parse + validate JSON from AI ─────────────────────────────────────────
  let parsed;
  try {
    parsed = parseAIJson(rawText);
  } catch (parseErr) {
    console.error("Failed to parse AI JSON:", parseErr.message);
    console.error("Raw AI output:", rawText.slice(0, 500));
    return res.status(502).json({
      error: "AI returned an unexpected format. Please try again."
    });
  }

  // ── Sanitize and send ──────────────────────────────────────────────────────
  const result = sanitizeResult(parsed);
  return res.json(result);
});

/**
 * Catch-all — 404 for unknown routes
 */
app.use((_req, res) => {
  res.status(404).json({ error: "Not found." });
});


// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildPrompt(content, title, length) {
  const lengthGuide = {
    brief:    "Provide exactly 3 bullet points. Be extremely concise.",
    standard: "Provide 5 to 8 bullet points. Balance detail with brevity.",
    detailed: "Provide 8 to 12 bullet points. Be thorough."
  }[length] || "Provide 5 to 8 bullet points.";

  // Trim content to ~10,000 chars to stay within Llama's context comfortably
  const trimmed = content.length > 10_000
    ? content.slice(0, 10_000) + "\n\n[Content trimmed]"
    : content;

  return `Analyze this webpage and return a JSON summary.

Page Title: ${title}

Page Content:
---
${trimmed}
---

Return ONLY this JSON structure (raw, no markdown, no backticks):
{
  "summary": ["bullet 1", "bullet 2", "..."],
  "keyInsights": ["insight 1", "insight 2", "insight 3"],
  "mainTopic": "one sentence describing the page",
  "sentiment": "positive|negative|neutral|mixed",
  "readingTimeMinutes": <integer>,
  "wordCount": <integer>,
  "highlights": ["short phrase 1", "short phrase 2", "short phrase 3"]
}

Rules:
- summary: ${lengthGuide}
- keyInsights: exactly 3 items
- mainTopic: one concise sentence
- sentiment: exactly one of: positive, negative, neutral, mixed
- readingTimeMinutes: based on 238 words/minute reading speed
- wordCount: approximate word count of original content
- highlights: 3 short verbatim phrases (5–10 words) from the content worth highlighting
- Do NOT include any text outside the JSON object`;
}

function parseAIJson(rawText) {
  // Strip accidental markdown fences
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Try extracting a JSON object from within the text
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("No valid JSON found in AI response");
  }
}

function sanitizeText(str) {
  if (typeof str !== "string") return "";
  // Strip HTML tags and trim
  return str.replace(/<[^>]*>/g, "").trim().slice(0, 500);
}

function sanitizeResult(parsed) {
  const validSentiments = ["positive", "negative", "neutral", "mixed"];
  return {
    summary: Array.isArray(parsed.summary)
      ? parsed.summary.slice(0, 12).map(sanitizeText)
      : [],
    keyInsights: Array.isArray(parsed.keyInsights)
      ? parsed.keyInsights.slice(0, 3).map(sanitizeText)
      : [],
    mainTopic: sanitizeText(parsed.mainTopic || ""),
    sentiment: validSentiments.includes(parsed.sentiment) ? parsed.sentiment : "neutral",
    readingTimeMinutes: Math.max(1, Math.min(parseInt(parsed.readingTimeMinutes) || 1, 120)),
    wordCount: Math.max(0, Math.min(parseInt(parsed.wordCount) || 0, 100_000)),
    highlights: Array.isArray(parsed.highlights)
      ? parsed.highlights.slice(0, 3).map(sanitizeText)
      : []
  };
}


// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ AI Summarizer Proxy running on port ${PORT}`);
  console.log(`   Model: ${AI_MODEL}`);
  console.log(`   Rate limit: ${RATE_LIMIT_MAX} req/min per IP`);
  console.log(`   Health check: GET /`);
  console.log(`   Summarize: POST /summarize`);
});