const PROXY_URL = "https://ai-page-summarizer.onrender.com";

//  Rate Limiting
const rateLimiter = {
  requestTimestamps: [],
  MAX_ALLOWED_REQUESTS: 10,
  TIME_WINDOW_MS: 60 * 1000,

  canMakeRequest() {
    const currentTime = Date.now();
    // Drop timestamps older than the time window
    this.requestTimestamps = this.requestTimestamps.filter(
      timestamp => currentTime - timestamp < this.TIME_WINDOW_MS
    );
    return this.requestTimestamps.length < this.MAX_ALLOWED_REQUESTS;
  },

  recordRequest() {
    this.requestTimestamps.push(Date.now());
  }
};


//  Message Handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only accept messages from our own extension
  if (sender.id && sender.id !== chrome.runtime.id) {
    sendResponse({ error: "Unauthorized sender." });
    return false;
  }

  if (message.type === "SUMMARIZE_PAGE") {
    handleSummarize(message.payload)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err  => sendResponse({ success: false, error: err.message }));
    return true; // keep async channel open
  }

  if (message.type === "CLEAR_CACHE") {
    clearCacheForUrl(message.payload.url)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  return false;
});


//  Main Summarize Handler 
async function handleSummarize({ content, url, title, mode }) {
  // 1. Return cached result if available (skip if user hit "Refresh")
  const cached = await getCachedSummary(url);
  if (cached && mode !== "refresh") {
    return { ...cached, fromCache: true };
  }

  // 2. Client-side rate limit guard
  if (!rateLimiter.canMakeRequest()) {
    throw new Error("Rate limit reached. Please wait a moment before summarizing again.");
  }

  // 3. Load preferences (summary length, highlight toggle — no API key needed)
  const settings = await getSettings();

  // 4. Call our proxy server
  const summary = await callProxy(content, title, settings.summaryLength);

  rateLimiter.recordRequest();

  // 5. Attach metadata, cache, and return
  const result = {
    ...summary,
    url,
    title,
    timestamp: Date.now(),
    fromCache: false
  };

  await cacheSummary(url, result);
  return result;
}


//  Proxy Call
async function callProxy(content, title, summaryLength = "standard") {
  let response;

  try {
    response = await fetch(`${PROXY_URL}/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: content.slice(0, 12_000), // trim before sending
        title,
        summaryLength
      })
    });
  } catch (networkErr) {
    // Most likely cause: Render free tier is sleeping (cold start)
    throw new Error(
      "Could not reach the proxy server. It may be waking up — wait 30 seconds and try again."
    );
  }

  // Parse response body — errors also return JSON from the proxy
  let data;
  try {
    data = await response.json();
  } catch (parseErr) {
    data = {};
  }

  if (!response.ok) {
    throw new Error(data.error || `Proxy error ${response.status}: ${response.statusText}`);
  }

  return data;
}


//  Settings──
async function getSettings() {
  const result = await chrome.storage.sync.get({
    summaryLength:    "standard",
    theme:            "light",
    highlightEnabled: true
  });
  return result;
}


//  Cache Helpers
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CACHE_PREFIX = "summary_cache_";

function urlToKey(url) {
  try {
    const u = new URL(url);
    u.hash = ""; // ignore fragments
    return CACHE_PREFIX + btoa(u.toString()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 80);
  } catch {
    return CACHE_PREFIX + btoa(url).replace(/[^a-zA-Z0-9]/g, "").slice(0, 80);
  }
}

async function getCachedSummary(url) {
  const key   = urlToKey(url);
  const result = await chrome.storage.local.get(key);
  const entry  = result[key];

  if (!entry) return null;

  // Expired — delete and return nothing
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    await chrome.storage.local.remove(key);
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