# AI Page Summarizer

A Chrome Extension (Manifest V3) that extracts content from any webpage and returns a structured AI summary — including bullet-point takeaways, key insights, sentiment, estimated reading time, and in-page highlights. No API key required by the user. The Groq API key lives exclusively on a proxy server you deploy once.

---

## Demo

> Video link here [https://www.loom.com/share/7e332843a11643018116a82ed03added]

---

## Features

- **Instant summarization** of any HTTP/HTTPS page
- **Structured output** — summary bullets, key insights, main topic, sentiment chip, reading time, word count
- **In-page highlight** toggle — marks key phrases directly on the page
- **Summary length control** — Brief (3 bullets), Standard (5–8), Detailed (8–12)
- **30-minute cache** per URL — no duplicate API calls
- **Dark / Light theme** with persistence
- **Copy to clipboard** — formatted plain-text summary
- **Refresh** to bypass cache and re-summarize
- Free to run — powered by [Groq](https://groq.com) + Llama 3.1 (no paid tier required)

---

## File Structure

```
ai-page-summarizer/
├── manifest.json                  # MV3 extension manifest
├── render.yaml                    # One-click Render.com deploy config
│
├── background/
│   └── service-worker.js          # Handles AI requests, caching, rate limiting
│
├── content/
│   └── content.js                 # Page content extraction + highlight injection
│
├── popup/
│   ├── popup.html                 # Extension popup UI
│   ├── popup.css                  # Styles (light/dark theme via CSS vars)
│   └── popup.js                   # Popup logic and state management
│
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
│
└── backend/
    ├── index.js                   # Express proxy server — holds the Groq API key
    ├── package.json
    ├── .env.example               # Copy to .env and add your Groq key
    └── .gitignore
```

---

## Setup Instructions

### Prerequisites

- Google Chrome (or any Chromium browser)
- Node.js 18+ (for running the backend locally)
- A free [Groq API key](https://console.groq.com) — takes ~30 seconds to get

---

### Step 1 — Deploy the Proxy Server

The extension never holds an API key. All AI calls go through a proxy server you control. You have two options:

#### Option A — Deploy to Render.com (recommended, stays free)

1. Fork or push this repo to GitHub.
2. Go to [render.com](https://render.com) and create a free account.
3. Click **New → Web Service** and connect your repo.
4. Render will auto-detect `render.yaml` and pre-fill all settings.
5. Under **Environment Variables**, add:
   ```
   GROQ_API_KEY = your_key_here
   ```
6. Click **Deploy**. Once live, note your service URL — it looks like:
   ```
   https://your-service-name.onrender.com
   ```

> ⚠️ Render's free tier spins down after 15 minutes of inactivity. The first request after idle takes ~30 seconds. The extension shows a "Proxy is waking up" hint automatically.

#### Option B — Run locally

```bash
cd backend
cp .env.example .env
# Edit .env and add your GROQ_API_KEY
npm install
npm start
# Server runs on http://localhost:3000
```

---

### Step 2 — Configure the Extension

Open `background/service-worker.js` and update the single proxy constant at the top:

```js
// Line 1 of background/service-worker.js
const PROXY_URL = "https://your-service-name.onrender.com";
//                 ↑ replace with your Render URL, or "http://localhost:3000" for local dev
```

---

### Step 3 — Load the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the root folder of this project (the one containing `manifest.json`)
5. The extension icon appears in your toolbar — pin it for easy access

To reload after making changes, click the refresh icon on the extension card at `chrome://extensions`.

---

### Step 4 — Verify it works

1. Navigate to any article page (e.g. a Wikipedia article, a news story)
2. Click the extension icon
3. Click **Summarize Page**
4. The summary should appear within ~5 seconds (or ~35 seconds on a cold Render start)

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Chrome Extension                  │
│                                                     │
│  ┌──────────┐   EXTRACT_CONTENT    ┌─────────────┐  │
│  │  popup   │ ─────────────────→  │   content   │  │
│  │ popup.js │ ←───────────────── │   script    │  │
│  └────┬─────┘   { content, url }  └─────────────┘  │
│       │                                             │
│       │  SUMMARIZE_PAGE message                     │
│       ↓                                             │
│  ┌────────────────┐                                 │
│  │ service-worker │  chrome.storage (cache/settings)│
│  │   (background) │ ──────────────────────────────→ │
│  └────────┬───────┘                                 │
│           │ fetch POST /summarize                   │
└───────────┼─────────────────────────────────────────┘
            │  HTTPS
            ↓
┌───────────────────────┐
│   Proxy Server        │   (Node.js / Express on Render.com)
│   backend/index.js    │
│                       │
│  - Rate limiting      │
│  - Prompt building    │
│  - Groq API call  ────┼──→  Groq API (Llama 3.1)
│  - JSON sanitization  │
└───────────────────────┘
```

### Component Responsibilities

**`popup.js`** — UI state machine. Manages the five states (empty, loading, error, results, settings), drives loading step animations, triggers content extraction and summarization, handles copy/clear/refresh actions and theme toggling.

**`content.js`** — Injected into every page. Responsible for two things: (1) extracting readable content using a three-strategy cascade, and (2) highlighting phrases on the page when the toggle is activated.

**`service-worker.js`** — The extension's backend. Receives messages from the popup, checks the per-URL cache, applies a client-side rate limit, calls the proxy over HTTPS, and writes results back to `chrome.storage.local`.

**`backend/index.js`** — The only component that ever sees the Groq API key. Accepts `POST /summarize`, builds a structured prompt, calls Groq's OpenAI-compatible API, parses and sanitizes the JSON response, and returns it to the extension.

---

## Content Extraction

The content script uses a three-strategy cascade, stopping at the first strategy that returns more than 300 characters:

**Strategy 1 — Semantic article selectors**
Queries a priority list of selectors like `article`, `[role="article"]`, `.post-content`, `.article-body`, etc. Most article pages and blogs are handled here.

**Strategy 2 — Landmark elements**
Falls back to `<main>`, `[role="main"]`, `#main`, `#content`, `.main-content`. Catches sites that use landmark elements without article-specific class names.

**Strategy 3 — Text-density scoring**
Iterates candidate `div`/`section` elements, scores each by word count, paragraph density, and link ratio (high link density = navigation, penalized), and picks the winner. This catches SPAs, dashboards, and sites with non-standard markup.

Before returning, all strategies strip noise elements: `<nav>`, `<header>`, `<footer>`, `<aside>`, ads, sidebars, cookie banners, social share buttons, comment sections, and `[aria-hidden]` nodes. Content is capped at 15,000 characters before sending to the service worker (which trims further to 12,000 before sending to the proxy).

---

## AI Integration

The extension uses the [Groq API](https://groq.com) with **Llama 3.1 8B Instant** as the default model — chosen because it is fast (often < 1s), free on Groq's free tier, and reliable for structured JSON output. Three models are available by changing one environment variable on the server:

| Model | Speed | Best for |
|---|---|---|
| `llama-3.1-8b-instant` | ~0.5s | Default — fast summarization |
| `llama3-70b-8192` | ~2s | More nuanced analysis |
| `mixtral-8x7b-32768` | ~1.5s | Long pages (32k context) |

The proxy builds a structured prompt that instructs the model to return a raw JSON object — no markdown, no preamble. The schema includes `summary` (array), `keyInsights` (array of 3), `mainTopic` (string), `sentiment` (enum), `readingTimeMinutes` (int), `wordCount` (int), and `highlights` (array of 3 verbatim short phrases).

Temperature is set to `0.3` to reduce hallucination and keep output consistent. If the model returns markdown fences around the JSON (a common failure mode), `parseAIJson()` strips them. If JSON parsing still fails, a regex extraction is attempted before the error is surfaced to the user.

---

## Security Decisions

**API key never touches the extension.** The Groq key lives only in an environment variable on the Render server, set via the Render dashboard (never committed to the repo). The extension only knows the proxy URL, which is not a secret.

**No `unsafe-eval` or `unsafe-inline` in the manifest CSP.** The manifest `content_security_policy` only relaxes `img-src` to allow `https:` and `data:` URIs (for favicons). Script execution is strictly `'self'`.

**Message sender validation.** The service worker checks `sender.id !== chrome.runtime.id` before processing any message, blocking messages from unexpected origins.

**Output sanitization at two layers.** The backend's `sanitizeResult()` strips HTML tags and truncates all string fields before they leave the server. The popup's `escapeHtml()` encodes `&`, `<`, `>`, `"`, and `'` before any AI-generated text is inserted into the DOM via `innerHTML`.

**Minimal permissions.** The manifest requests only `activeTab` (access the current tab on click), `storage` (cache and settings), and `scripting` (inject content script on demand). No `<all_urls>` host permission for the extension itself.

**Rate limiting at two layers.** The proxy enforces 15 requests/IP/minute (configurable via `RATE_LIMIT_MAX`). The service worker maintains a secondary 10 requests/minute client-side guard. The backend limit is the authoritative one since the service worker's in-memory state resets if it goes idle.

**Content trimming prevents prompt injection via page content.** Extracted content is capped at 10,000 characters on the backend. The system prompt instructs the model to respond only with JSON, reducing the surface for prompt injection attacks embedded in malicious page content.

---

## Trade-offs

**Groq / Llama 3.1 over OpenAI or Gemini.** Groq's free tier is generous enough for personal use without a credit card. The trade-off is that Llama 3.1 8B occasionally produces less nuanced summaries than GPT-4o on complex academic content. The model is configurable via `AI_MODEL` env var, so upgrading is a one-line change.

**Render free tier.** Hosting is free but the server sleeps after 15 minutes of inactivity. The cold start (~30 seconds) is handled gracefully with a user-visible hint, but it's a worse experience than a paid always-on service. The `render.yaml` makes migrating to a paid plan or a different host a one-command operation.

**In-memory rate limiting on the backend.** The `rateLimitMap` resets on every Render deployment or server restart. For a personal tool this is acceptable. A production deployment would replace this with Redis.

**Heuristic content extraction over a readability library.** Shipping `@mozilla/readability` would add ~50KB to the extension and require a build step. The three-strategy heuristic handles the majority of article and blog pages without the added complexity. Pages with very unusual DOM structures may extract poorly.

**Cache stored in `chrome.storage.local`, not `chrome.storage.session`.** This means summaries persist across browser restarts, which is the desired behavior for a 30-minute cache. The trade-off is that the storage is bounded by Chrome's local storage quota (~10MB), but a single cached summary is well under 10KB, so this is not a practical concern.

---

## Local Development

```bash
# 1. Start the backend
cd backend
cp .env.example .env   # add your GROQ_API_KEY
npm install
npm run dev            # uses node --watch for auto-reload

# 2. Point the extension at localhost
# In background/service-worker.js, line 1:
const PROXY_URL = "http://localhost:3000";

# 3. Load unpacked extension in Chrome
# chrome://extensions → Developer mode → Load unpacked → select project root

# 4. Test the health endpoint
curl http://localhost:3000/
# → { "status": "ok", "model": "llama-3.1-8b-instant", ... }

# 5. Test the summarize endpoint directly
curl -X POST http://localhost:3000/summarize \
  -H "Content-Type: application/json" \
  -d '{"content":"The quick brown fox jumps over the lazy dog. This is a test article with enough content to summarize. It discusses various topics including foxes, dogs, and their interactions in the wild. The relationship between predators and prey is fascinating and well-documented.","title":"Test Page","summaryLength":"brief"}'
```

---

## Environment Variables (Backend)

| Variable | Default | Description |
|---|---|---|
| `GROQ_API_KEY` | *(required)* | Your Groq API key from console.groq.com |
| `AI_MODEL` | `llama-3.1-8b-instant` | Groq model to use |
| `MAX_TOKENS` | `1024` | Max tokens in AI response |
| `RATE_LIMIT_MAX` | `15` | Max requests per IP per minute |
| `PORT` | `3000` | Server port |

---

## Known Limitations

- Internal Chrome pages (`chrome://`, `chrome-extension://`, `about:`) cannot be summarized — this is a Chrome security restriction that cannot be bypassed.
- PDF pages displayed in the browser's built-in PDF viewer are not supported — the content script cannot read PDF content.
- Paywalled pages will extract only the visible (teaser) content, producing a partial summary.
- The Render free tier cold start adds ~30 seconds to the first request after 15 minutes of inactivity.

---

Built for Frontend Wizards Stage 4a.

