"use strict";

// DOM refs
const $ = id => document.getElementById(id);
const els = {
  pageTitle:      $("page-title"),
  pageFavicon:    $("page-favicon"),
  cacheBadge:     $("cache-badge"),
  emptyState:     $("empty-state"),
  loadingState:   $("loading-state"),
  loadingText:    $("loading-text"),
  loadingSteps:   $("loading-steps"),
  errorState:     $("error-state"),
  errorMessage:   $("error-message"),
  results:        $("results"),
  summaryList:    $("summary-list"),
  insightsList:   $("insights-list"),
  topicText:      $("topic-text"),
  metaSentiment:  $("meta-sentiment"),
  sentimentVal:   $("sentiment-val"),
  sentimentIcon:  $("sentiment-icon"),
  readingTimeVal: $("reading-time-val"),
  wordCountVal:   $("word-count-val"),
  highlightRow:   $("highlight-row"),
  toggleHighlight: $("toggle-highlight"),

  // Buttons
  btnSummarize:   $("btn-summarize"),
  btnClear:       $("btn-clear"),
  btnCopy:        $("btn-copy"),
  btnRefresh:     $("btn-refresh"),
  btnRetry:       $("btn-retry"),
  btnSettings:    $("btn-settings"),
  btnCloseSettings: $("btn-close-settings"),
  btnSaveSettings: $("btn-save-settings"),
  btnTheme:       $("btn-theme"),
  btnToggleKey:   $("btn-toggle-key"),

  // Settings
  settingsOverlay: $("settings-overlay"),
  selProvider:    $("sel-provider"),
  inpApiKey:      $("inp-api-key"),
  selModel:       $("sel-model"),
  selLength:      $("sel-length"),
  chkHighlight:   $("chk-highlight"),
  saveFeedback:   $("save-feedback"),
  iconMoon:       document.querySelector(".icon-moon"),
  iconSun:        document.querySelector(".icon-sun"),
};

// State
let currentTab = null;
let currentSummary = null;
let isHighlightActive = false;

const MODELS = {
  anthropic: [
    { value: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku (fast)" },
    { value: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet (smart)" },
    { value: "claude-opus-4-20250514", label: "Claude Opus 4 (powerful)" }
  ],
  openai: [
    { value: "gpt-4o-mini", label: "GPT-4o Mini (fast)" },
    { value: "gpt-4o", label: "GPT-4o (smart)" },
    { value: "gpt-4-turbo", label: "GPT-4 Turbo (powerful)" }
  ],
  gemini: [
    { value: "gemini-1.5-flash", label: "Gemini 1.5 Flash (fast)" },
    { value: "gemini-1.5-pro", label: "Gemini 1.5 Pro (smart)" },
    { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash (latest)" }
  ]
};

const SENTIMENT_META = {
  positive: { icon: "↑", label: "positive" },
  negative: { icon: "↓", label: "negative" },
  neutral:  { icon: "◐", label: "neutral" },
  mixed:    { icon: "⇅", label: "mixed" }
};

// Init
document.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  await loadCurrentTab();
  await loadSettings();
  bindEvents();
});

async function initTheme() {
  const { theme = "light" } = await chrome.storage.sync.get("theme");
  applyTheme(theme);
}

async function loadCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  if (!tab) return;

  // Update page info bar
  els.pageTitle.textContent = tab.title || tab.url || "Unknown page";
  els.pageTitle.title = tab.title || "";

  // Set favicon
  if (tab.favIconUrl) {
    const img = document.createElement("img");
    img.src = tab.favIconUrl;
    img.alt = "";
    img.onerror = () => {}; // graceful fallback to default icon
    els.pageFavicon.innerHTML = "";
    els.pageFavicon.appendChild(img);
  }
}

async function loadSettings() {
  const settings = await chrome.storage.sync.get({
    provider: "anthropic",
    apiKey: "",
    model: "",
    summaryLength: "standard",
    theme: "light",
    highlightEnabled: true
  });

  els.selProvider.value = settings.provider;
  populateModels(settings.provider);
  if (settings.model) els.selModel.value = settings.model;
  els.selLength.value = settings.summaryLength;
  els.chkHighlight.checked = settings.highlightEnabled;

  // Show masked key placeholder
  if (settings.apiKey) {
    els.inpApiKey.placeholder = "••••••••••••••••••••" + settings.apiKey.slice(-4);
  }
}

function populateModels(provider) {
  const models = MODELS[provider] || [];
  els.selModel.innerHTML = models
    .map(m => `<option value="${m.value}">${m.label}</option>`)
    .join("");
}

// Events
function bindEvents() {
  els.btnSummarize.addEventListener("click", () => startSummarize("normal"));
  els.btnRetry.addEventListener("click",     () => startSummarize("normal"));
  els.btnRefresh.addEventListener("click",   () => startSummarize("refresh"));
  els.btnClear.addEventListener("click", handleClear);
  els.btnCopy.addEventListener("click", handleCopy);
  els.toggleHighlight.addEventListener("click", handleHighlightToggle);
  els.btnTheme.addEventListener("click", handleThemeToggle);
  els.btnSettings.addEventListener("click", openSettings);
  els.btnCloseSettings.addEventListener("click", closeSettings);
  els.btnSaveSettings.addEventListener("click", saveSettings);
  els.settingsOverlay.addEventListener("click", e => {
    if (e.target === els.settingsOverlay) closeSettings();
  });
  els.selProvider.addEventListener("change", () => populateModels(els.selProvider.value));
  els.btnToggleKey.addEventListener("click", toggleKeyVisibility);

  // Keyboard: Escape closes settings
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && els.settingsOverlay.style.display !== "none") {
      closeSettings();
    }
  });
}

// Summarize flow
async function startSummarize(mode = "normal") {
  if (!currentTab?.id) {
    showError("Cannot access this tab. Try refreshing.");
    return;
  }

  // Check for restricted pages
  const url = currentTab.url || "";
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") ||
      url.startsWith("about:") || url.startsWith("edge://")) {
    showError("Cannot summarize browser internal pages.");
    return;
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    showError("Only HTTP/HTTPS pages can be summarized.");
    return;
  }

  showLoading();

  try {
    // Step 1: Extract content
    advanceLoadingStep("extract");
    const extracted = await extractContent();

    if (!extracted?.content || extracted.content.length < 100) {
      showError("Not enough readable content found on this page. Try a different page.");
      return;
    }

    // Step 2: Send to AI
    advanceLoadingStep("analyze");
    els.loadingText.textContent = "Analyzing with AI…";

    const result = await chrome.runtime.sendMessage({
      type: "SUMMARIZE_PAGE",
      payload: {
        content: extracted.content,
        url: currentTab.url,
        title: currentTab.title || extracted.title,
        mode
      }
    });

    if (!result.success) {
      // Check for missing API key
      if (result.error?.includes("No API key")) {
        showError(result.error + " Click ⚙ Settings above.");
      } else {
        showError(result.error || "An unknown error occurred.");
      }
      return;
    }

    // Step 3: Render
    advanceLoadingStep("format");
    els.loadingText.textContent = "Formatting summary…";

    await sleep(200); // brief pause so user sees the last step
    currentSummary = result.data;
    renderResults(result.data);

  } catch (err) {
    showError(err.message || "Failed to communicate with the extension.");
  }
}

async function extractContent() {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      currentTab.id,
      { type: "EXTRACT_CONTENT" },
      response => {
        if (chrome.runtime.lastError) {
          // Content script may not be injected — try scripting API
          injectAndExtract().then(resolve).catch(reject);
          return;
        }
        if (response?.success) {
          resolve(response.data);
        } else {
          reject(new Error(response?.error || "Content extraction failed."));
        }
      }
    );
  });
}

async function injectAndExtract() {
  // Fallback: programmatically inject content script
  await chrome.scripting.executeScript({
    target: { tabId: currentTab.id },
    files: ["content/content.js"]
  });

  await sleep(300);

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      currentTab.id,
      { type: "EXTRACT_CONTENT" },
      response => {
        if (chrome.runtime.lastError) {
          reject(new Error("Could not access page content."));
          return;
        }
        if (response?.success) resolve(response.data);
        else reject(new Error(response?.error || "Extraction failed."));
      }
    );
  });
}

// Render results
function renderResults(data) {
  // Meta chips
  els.readingTimeVal.textContent = data.readingTimeMinutes ?? "–";
  els.wordCountVal.textContent   = data.wordCount ? data.wordCount.toLocaleString() : "–";

  const sentMeta = SENTIMENT_META[data.sentiment] || SENTIMENT_META.neutral;
  els.metaSentiment.setAttribute("data-sentiment", data.sentiment || "neutral");
  els.sentimentVal.textContent  = sentMeta.label;
  els.sentimentIcon.textContent = sentMeta.icon;

  // Topic
  els.topicText.innerHTML = escapeHtml(data.mainTopic || "");

  // Summary bullets
  els.summaryList.innerHTML = (data.summary || [])
    .map(item => `<li>${escapeHtml(item)}</li>`)
    .join("");

  // Insights
  els.insightsList.innerHTML = (data.keyInsights || [])
    .map(item => `<li>${escapeHtml(item)}</li>`)
    .join("");

  // Cache badge
  if (data.fromCache) {
    els.cacheBadge.style.display = "inline-block";
  } else {
    els.cacheBadge.style.display = "none";
  }

  // Check settings for highlight availability
  chrome.storage.sync.get({ highlightEnabled: true }, ({ highlightEnabled }) => {
    els.highlightRow.style.display = highlightEnabled ? "flex" : "none";
  });

  // Reset highlight toggle
  setHighlightToggle(false);
  isHighlightActive = false;

  showPanel("results");
  showActionButtons(true);
}

//  Highlight toggle 
async function handleHighlightToggle() {
  if (!currentSummary || !currentTab?.id) return;

  isHighlightActive = !isHighlightActive;
  setHighlightToggle(isHighlightActive);

  if (isHighlightActive && currentSummary.highlights?.length) {
    chrome.tabs.sendMessage(currentTab.id, {
      type: "HIGHLIGHT_PHRASES",
      payload: { phrases: currentSummary.highlights }
    });
  } else {
    chrome.tabs.sendMessage(currentTab.id, { type: "REMOVE_HIGHLIGHTS" });
  }
}

function setHighlightToggle(active) {
  els.toggleHighlight.setAttribute("aria-checked", String(active));
}

//  Clear─
async function handleClear() {
  if (currentTab?.id) {
    chrome.tabs.sendMessage(currentTab.id, { type: "REMOVE_HIGHLIGHTS" });
  }

  if (currentTab?.url) {
    chrome.runtime.sendMessage({
      type: "CLEAR_CACHE",
      payload: { url: currentTab.url }
    });
  }

  currentSummary = null;
  isHighlightActive = false;
  els.cacheBadge.style.display = "none";
  showPanel("empty");
  showActionButtons(false);
}

//  Cop
async function handleCopy() {
  if (!currentSummary) return;

  const text = buildCopyText(currentSummary);

  try {
    await navigator.clipboard.writeText(text);
    const original = els.btnCopy.innerHTML;
    els.btnCopy.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><polyline points="20 6 9 17 4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Copied!`;
    els.btnCopy.style.color = "var(--green)";
    setTimeout(() => {
      els.btnCopy.innerHTML = original;
      els.btnCopy.style.color = "";
    }, 1800);
  } catch {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}

function buildCopyText(data) {
  const lines = [
    `📄 ${data.title || "Page Summary"}`,
    `🔗 ${data.url}`,
    `⏱ ${data.readingTimeMinutes} min read · ${data.wordCount?.toLocaleString()} words`,
    ``,
    `📝 TOPIC`,
    data.mainTopic,
    ``,
    `📋 SUMMARY`,
    ...(data.summary || []).map(s => `• ${s}`),
    ``,
    `⚡ KEY INSIGHTS`,
    ...(data.keyInsights || []).map((s, i) => `${i + 1}. ${s}`),
    ``,
    `—`,
    `Generated by AI Page Summarizer`
  ];
  return lines.join("\n");
}


//  Settings
function openSettings() {
  els.settingsOverlay.style.display = "flex";
  els.btnCloseSettings.focus();
}

function closeSettings() {
  els.settingsOverlay.style.display = "none";
  els.btnSettings.focus();
}

async function saveSettings() {
  const provider = els.selProvider.value;
  const rawKey = els.inpApiKey.value.trim();
  const model = els.selModel.value;
  const summaryLength = els.selLength.value;
  const highlightEnabled = els.chkHighlight.checked;

  // Validate key format only if a new key was entered
  if (rawKey && !validateApiKey(rawKey, provider)) {
    showSaveFeedback("⚠ Key format looks wrong for " + provider, true);
    return;
  }

  const toSave = { provider, model, summaryLength, highlightEnabled };

  // Only update key if user typed a new one
  if (rawKey) {
    toSave.apiKey = rawKey;
    // Update placeholder
    els.inpApiKey.value = "";
    els.inpApiKey.placeholder = "••••••••••••••••••••" + rawKey.slice(-4);
  }

  await chrome.storage.sync.set(toSave);

  showSaveFeedback("✓ Saved!");
  setTimeout(closeSettings, 700);
}

function validateApiKey(key, provider) {
  if (provider === "anthropic") return key.startsWith("sk-ant-");
  if (provider === "openai")    return key.startsWith("sk-");
  if (provider === "gemini")    return key.startsWith("AIza");
  return key.length > 10;
}

function showSaveFeedback(msg, isError = false) {
  els.saveFeedback.textContent = msg;
  els.saveFeedback.style.color = isError ? "var(--red)" : "var(--green)";
  els.saveFeedback.classList.add("visible");
  setTimeout(() => els.saveFeedback.classList.remove("visible"), 2500);
}

function toggleKeyVisibility() {
  const isPassword = els.inpApiKey.type === "password";
  els.inpApiKey.type = isPassword ? "text" : "password";
  els.btnToggleKey.querySelector(".eye-open").style.display = isPassword ? "none" : "";
  els.btnToggleKey.querySelector(".eye-closed").style.display = isPassword ? "" : "none";
}

//  Theme─
async function handleThemeToggle() {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  const next = current === "light" ? "dark" : "light";
  applyTheme(next);
  await chrome.storage.sync.set({ theme: next });
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const isDark = theme === "dark";
  els.iconMoon.style.display = isDark ? "none" : "";
  els.iconSun.style.display  = isDark ? "" : "none";
}

//  Loading steps 
let completedSteps = new Set();

function advanceLoadingStep(step) {
  // Mark previous steps done
  const order = ["extract", "analyze", "format"];
  const idx = order.indexOf(step);

  order.forEach((s, i) => {
    const el = els.loadingSteps.querySelector(`[data-step="${s}"]`);
    if (!el) return;
    if (i < idx) {
      el.classList.remove("active");
      el.classList.add("done");
    } else if (i === idx) {
      el.classList.add("active");
      el.classList.remove("done");
    } else {
      el.classList.remove("active", "done");
    }
  });
}

//  Panel management 
function showPanel(panel) {
  els.emptyState.style.display   = panel === "empty"   ? "" : "none";
  els.loadingState.style.display = panel === "loading" ? "" : "none";
  els.errorState.style.display   = panel === "error"   ? "" : "none";
  els.results.style.display      = panel === "results" ? "" : "none";
}

function showLoading() {
  showPanel("loading");
  els.loadingText.textContent = "Reading page content…";
  completedSteps.clear();
  advanceLoadingStep("extract");
  showActionButtons(false);
  els.btnSummarize.disabled = true;
}

function showError(msg) {
  els.errorMessage.textContent = msg || "An error occurred.";
  showPanel("error");
  showActionButtons(false);
  els.btnSummarize.disabled = false;
}

function showActionButtons(hasResults) {
  els.btnSummarize.disabled = false;
  els.btnClear.style.display   = hasResults ? "" : "none";
  els.btnCopy.style.display    = hasResults ? "" : "none";
  els.btnRefresh.style.display = hasResults ? "" : "none";
}

// Security
function escapeHtml(str) {
  // Content is already sanitized by service worker, but double-escape for safety
  if (typeof str !== "string") return "";
  return str
    .replace(/&amp;/g, "&")   // undo over-escaping from service worker
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    // Re-escape for innerHTML context
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Utilities
const sleep = ms => new Promise(r => setTimeout(r, ms));