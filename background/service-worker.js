// Rate Limiting
const rateLimiter = {
  requestTimestamps: [],
  MAX_ALLOWED_REQUESTS: 10,
  TIME_WINDOW_MS: 60 * 1000,

  canMakeRequest() {
    const currentTime = Date.now();
    
    this.requestTimestamps = this.requestTimestamps.filter(timestamp => {
      const ageOfRequest = currentTime - timestamp;
      return ageOfRequest < this.TIME_WINDOW_MS;
    });

    const currentRequestCount = this.requestTimestamps.length;
    return currentRequestCount < this.MAX_ALLOWED_REQUESTS;
  },

  recordRequest() {
    this.requestTimestamps.push(Date.now());
  }
};

// Message Handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Validate sender — only accept from this extension
  if (!sender.id || sender.id !== chrome.runtime.id) {
    sendResponse({ error: "Unauthorized sender." });
    return false;
  }
 
  if (message.type === "SUMMARIZE_PAGE") {
    handleSummarize(message.payload)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
 
  if (message.type === "CLEAR_CACHE") {
    clearCacheForUrl(message.payload.url)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
 
  return false;
});

// Main summarize function
async function handleSummarize({ content, url, title, mode }) {
  // 1. Check cache first
  const cached = await getCachedSummary(url);
  if (cached && mode !== "refresh") {
    return { ...cached, fromCache: true };
  }
 
  // 2. Rate limit check
  if (!rateLimiter.canMakeRequest()) {
    throw new Error("Rate limit reached. Please wait a moment before summarizing again.");
  }
 
  // 3. Load settings
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw new Error("No API key configured. Please open Settings in the popup.");
  }
 
  // 4. Build prompt
  const prompt = buildPrompt(content, title, settings.summaryLength);
 
  // 5. Call AI provider
  let summary;
  const provider = settings.provider || "anthropic";
 
  if (provider === "anthropic") {
    summary = await callAnthropic(prompt, settings.apiKey, settings.model);
  } else if (provider === "openai") {
    summary = await callOpenAI(prompt, settings.apiKey, settings.model);
  } else if (provider === "gemini") {
    summary = await callGemini(prompt, settings.apiKey, settings.model);
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }
 
  rateLimiter.record();
 
  // 6. Parse structured output
  const parsed = parseAIResponse(summary);
 
  // 7. Cache result
  const result = {
    ...parsed,
    url,
    title,
    timestamp: Date.now(),
    fromCache: false
  };
 
  await cacheSummary(url, result);
  return result;
}

// Prompt builder
function buildPrompt(content, title, length = "standard") {
  const lengthInstructions = {
    brief: "Provide exactly 3 bullet points maximum. Be extremely concise.",
    standard: "Provide 5–8 bullet points. Balance detail with conciseness.",
    detailed: "Provide 8–12 bullet points. Be thorough and comprehensive."
  };
 
  const instruction = lengthInstructions[length] || lengthInstructions.standard;
 
  // Trim content to avoid token limits (~12,000 chars ≈ ~3,000 tokens)
  const trimmed = content.length > 12000
    ? content.slice(0, 12000) + "\n\n[Content truncated for length...]"
    : content;
 
  return `You are an expert content analyst. Analyze the following webpage content and produce a structured summary.
 
Page Title: ${title}
 
Page Content:
---
${trimmed}
---
 
Respond ONLY with a valid JSON object in this exact format (no markdown, no code blocks, just raw JSON):
{
  "summary": ["bullet point 1", "bullet point 2", "..."],
  "keyInsights": ["insight 1", "insight 2", "insight 3"],
  "mainTopic": "one sentence describing what this page is about",
  "sentiment": "positive|negative|neutral|mixed",
  "readingTimeMinutes": <integer>,
  "wordCount": <integer>,
  "highlights": ["exact short phrase from text 1", "exact short phrase from text 2", "exact short phrase from text 3"]
}
 
Rules:
- ${instruction}
- keyInsights: exactly 3 most important takeaways
- mainTopic: one concise sentence
- sentiment: one of the four values only
- readingTimeMinutes: estimate based on 238 words/min average
- wordCount: approximate word count of the original content
- highlights: 3 short verbatim phrases (5–10 words each) from the text worth highlighting
- ALL strings must be properly escaped JSON
- Do NOT include any text outside the JSON object`;
}

// Anthropic Claude API
async function callAnthropic(prompt, apiKey, model = "claude-3-5-haiku-20241022") {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }]
    })
  });
 
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Anthropic API error ${response.status}: ${err?.error?.message || response.statusText}`);
  }
 
  const data = await response.json();
  return data.content?.[0]?.text || "";
}
 
// OpenAI GPT API
async function callOpenAI(prompt, apiKey, model = "gpt-4o-mini") {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      messages: [
        {
          role: "system",
          content: "You are an expert content analyst. Always respond with valid raw JSON only — no markdown, no code blocks."
        },
        { role: "user", content: prompt }
      ]
    })
  });
 
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`OpenAI API error ${response.status}: ${err?.error?.message || response.statusText}`);
  }
 
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}
 
// Google Gemini API 
async function callGemini(prompt, apiKey, model = "gemini-1.5-flash") {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
 
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 1500, temperature: 0.2 }
    })
  });
 
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Gemini API error ${response.status}: ${err?.error?.message || response.statusText}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// JSON parsing and validation
function parseAIResponse(rawText) {
  // Strip any accidental markdown code fences
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
 
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Attempt to extract JSON from within text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        throw new Error("AI returned malformed JSON. Please try again.");
      }
    } else {
      throw new Error("AI returned an unexpected format. Please try again.");
    }
  }
 
  // Validate & provide defaults
  return {
    summary: Array.isArray(parsed.summary) ? parsed.summary.map(sanitizeText) : [],
    keyInsights: Array.isArray(parsed.keyInsights) ? parsed.keyInsights.map(sanitizeText) : [],
    mainTopic: sanitizeText(parsed.mainTopic || ""),
    sentiment: ["positive", "negative", "neutral", "mixed"].includes(parsed.sentiment)
      ? parsed.sentiment
      : "neutral",
    readingTimeMinutes: Number.isInteger(parsed.readingTimeMinutes) ? parsed.readingTimeMinutes : 1,
    wordCount: Number.isInteger(parsed.wordCount) ? parsed.wordCount : 0,
    highlights: Array.isArray(parsed.highlights) ? parsed.highlights.map(sanitizeText) : []
  };
}

// Text sanitization
function sanitizeText(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/\//g, "&#x2F;")
    .trim();
}

// Cache utilities & helpers
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CACHE_PREFIX = "summary_cache_";
 
function urlToKey(url) {
  // Normalize URL (remove fragments, some query params)
  try {
    const u = new URL(url);
    u.hash = "";
    return CACHE_PREFIX + btoa(u.toString()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 80);
  } catch {
    return CACHE_PREFIX + btoa(url).replace(/[^a-zA-Z0-9]/g, "").slice(0, 80);
  }
}
 
async function getCachedSummary(url) {
  const key = urlToKey(url);
  const result = await chrome.storage.local.get(key);
  const entry = result[key];
 
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    await chrome.storage.local.remove(key); // expired
    return null;
  }
 
  return entry;
}
 
async function cacheSummary(url, data) {
  const key = urlToKey(url);
  await chrome.storage.local.set({ [key]: data });
}
 
async function clearCacheForUrl(url) {
  const key = urlToKey(url);
  await chrome.storage.local.remove(key);
}

// Helpers Settings
async function getSettings() {
  const result = await chrome.storage.sync.get({
    provider: "anthropic",
    apiKey: "",
    model: "",
    summaryLength: "standard",
    theme: "light",
    highlightEnabled: true
  });
  return result;
}

// async function getModelForProvider(provider) {
//   const stored = (await getSettings()).model;
//   if (stored) return stored;

//   switch (provider) {
//     case "anthropic":
//       return "claude-3-5-haiku-20241022";
//     case "openai":
//       return "gpt-4o-mini";
//     case "gemini":
//       return "gemini-1.5-flash";
//     default:
//       return "claude-3-5-haiku-20241022";
//   }
// }

