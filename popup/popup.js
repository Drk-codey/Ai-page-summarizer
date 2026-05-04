"use strict";

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const els = {
  pageTitle:       $("page-title"),
  pageFavicon:     $("page-favicon"),
  cacheBadge:      $("cache-badge"),
  emptyState:      $("empty-state"),
  loadingState:    $("loading-state"),
  loadingText:     $("loading-text"),
  loadingSteps:    $("loading-steps"),
  coldStartHint:   $("cold-start-hint"),
  errorState:      $("error-state"),
  errorMessage:    $("error-message"),
  results:         $("results"),
  summaryList:     $("summary-list"),
  insightsList:    $("insights-list"),
  topicText:       $("topic-text"),
  metaSentiment:   $("meta-sentiment"),
  sentimentVal:    $("sentiment-val"),
  sentimentIcon:   $("sentiment-icon"),
  readingTimeVal:  $("reading-time-val"),
  wordCountVal:    $("word-count-val"),
  highlightRow:    $("highlight-row"),
  toggleHighlight: $("toggle-highlight"),

  // Buttons
  btnSummarize:      $("btn-summarize"),
  btnClear:          $("btn-clear"),
  btnCopy:           $("btn-copy"),
  btnRefresh:        $("btn-refresh"),
  btnRetry:          $("btn-retry"),
  btnSettings:       $("btn-settings"),
  btnCloseSettings:  $("btn-close-settings"),
  btnSaveSettings:   $("btn-save-settings"),
  btnTheme:          $("btn-theme"),

  // Settings
  settingsOverlay: $("settings-overlay"),
  selLength:       $("sel-length"),
  chkHighlight:    $("chk-highlight"),
  saveFeedback:    $("save-feedback"),
  iconMoon:        document.querySelector(".icon-moon"),
  iconSun:         document.querySelector(".icon-sun"),
};

// ─── State ────────────────────────────────────────────────────────────────────
let currentTab    = null;
let currentSummary = null;
let isHighlightActive = false;
let coldStartTimer = null;

const SENTIMENT_META = {
  positive: { icon: "↑", label: "positive" },
  negative: { icon: "↓", label: "negative" },
  neutral:  { icon: "◐", label: "neutral"  },
  mixed:    { icon: "⇅", label: "mixed"    }
};

// ─── Init ─────────────────────────────────────────────────────────────────────
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

  els.pageTitle.textContent = tab.title || tab.url || "Unknown page";
  els.pageTitle.title = tab.title || "";

  if (tab.favIconUrl) {
    const img = document.createElement("img");
    img.src = tab.favIconUrl;
    img.alt = "";
    img.onerror = () => {};
    els.pageFavicon.innerHTML = "";
    els.pageFavicon.appendChild(img);
  }
}

async function loadSettings() {
  const settings = await chrome.storage.sync.get({
    summaryLength:    "standard",
    highlightEnabled: true
  });
  els.selLength.value = settings.summaryLength;
  els.chkHighlight.checked = settings.highlightEnabled;
}

// ─── Events ───────────────────────────────────────────────────────────────────
function bindEvents() {
  els.btnSummarize.addEventListener("click", () => startSummarize("normal"));
  els.btnRetry.addEventListener("click",     () => startSummarize("normal"));
  els.btnRefresh.addEventListener("click",   () => startSummarize("refresh"));
  els.btnClear.addEventListener("click",     handleClear);
  els.btnCopy.addEventListener("click",      handleCopy);
  els.toggleHighlight.addEventListener("click", handleHighlightToggle);
  els.btnTheme.addEventListener("click",     handleThemeToggle);
  els.btnSettings.addEventListener("click",  openSettings);
  els.btnCloseSettings.addEventListener("click", closeSettings);
  els.btnSaveSettings.addEventListener("click",  saveSettings);
  els.settingsOverlay.addEventListener("click", e => {
    if (e.target === els.settingsOverlay) closeSettings();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && els.settingsOverlay.style.display !== "none") closeSettings();
  });
}

// ─── Summarize flow ───────────────────────────────────────────────────────────
async function startSummarize(mode = "normal") {
  if (!currentTab?.id) { showError("Cannot access this tab."); return; }

  const url = currentTab.url || "";
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("about:")) {
    showError("Cannot summarize browser internal pages.");
    return;
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    showError("Only HTTP/HTTPS pages can be summarized.");
    return;
  }

  showLoading();

  try {
    // Step 1: Extract content from page
    advanceLoadingStep("extract");
    const extracted = await extractContent();

    if (!extracted?.content || extracted.content.length < 100) {
      showError("Not enough readable content found on this page.");
      return;
    }

    // Step 2: Call proxy via background worker
    advanceLoadingStep("analyze");
    els.loadingText.textContent = "Calling AI proxy…";

    // Show cold-start hint after 5 seconds (Render free tier can be slow)
    coldStartTimer = setTimeout(() => {
      els.coldStartHint.style.display = "";
    }, 5000);

    const result = await chrome.runtime.sendMessage({
      type: "SUMMARIZE_PAGE",
      payload: {
        content: extracted.content,
        url: currentTab.url,
        title: currentTab.title || extracted.title,
        mode
      }
    });

    clearTimeout(coldStartTimer);
    els.coldStartHint.style.display = "none";

    if (!result.success) {
      showError(result.error || "An unknown error occurred.");
      return;
    }

    // Step 3: Render
    advanceLoadingStep("format");
    els.loadingText.textContent = "Formatting summary…";
    await sleep(150);

    currentSummary = result.data;
    renderResults(result.data);

  } catch (err) {
    clearTimeout(coldStartTimer);
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
          injectAndExtract().then(resolve).catch(reject);
          return;
        }
        if (response?.success) resolve(response.data);
        else reject(new Error(response?.error || "Content extraction failed."));
      }
    );
  });
}

async function injectAndExtract() {
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
        if (chrome.runtime.lastError) { reject(new Error("Could not access page content.")); return; }
        if (response?.success) resolve(response.data);
        else reject(new Error(response?.error || "Extraction failed."));
      }
    );
  });
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderResults(data) {
  els.readingTimeVal.textContent = data.readingTimeMinutes ?? "–";
  els.wordCountVal.textContent   = data.wordCount ? data.wordCount.toLocaleString() : "–";

  const sentMeta = SENTIMENT_META[data.sentiment] || SENTIMENT_META.neutral;
  els.metaSentiment.setAttribute("data-sentiment", data.sentiment || "neutral");
  els.sentimentVal.textContent  = sentMeta.label;
  els.sentimentIcon.textContent = sentMeta.icon;

  els.topicText.innerHTML = escapeHtml(data.mainTopic || "");

  els.summaryList.innerHTML = (data.summary || [])
    .map(item => `<li>${escapeHtml(item)}</li>`).join("");

  els.insightsList.innerHTML = (data.keyInsights || [])
    .map(item => `<li>${escapeHtml(item)}</li>`).join("");

  els.cacheBadge.style.display = data.fromCache ? "inline-block" : "none";

  chrome.storage.sync.get({ highlightEnabled: true }, ({ highlightEnabled }) => {
    els.highlightRow.style.display = highlightEnabled ? "flex" : "none";
  });

  setHighlightToggle(false);
  isHighlightActive = false;
  showPanel("results");
  showActionButtons(true);
}

// ─── Highlights ───────────────────────────────────────────────────────────────
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

// ─── Clear ────────────────────────────────────────────────────────────────────
async function handleClear() {
  if (currentTab?.id)  chrome.tabs.sendMessage(currentTab.id, { type: "REMOVE_HIGHLIGHTS" });
  if (currentTab?.url) chrome.runtime.sendMessage({ type: "CLEAR_CACHE", payload: { url: currentTab.url } });

  currentSummary = null;
  isHighlightActive = false;
  els.cacheBadge.style.display = "none";
  showPanel("empty");
  showActionButtons(false);
}

// ─── Copy ─────────────────────────────────────────────────────────────────────
async function handleCopy() {
  if (!currentSummary) return;
  const text = [
    `📄 ${currentSummary.title || "Summary"}`,
    `🔗 ${currentSummary.url}`,
    `⏱ ${currentSummary.readingTimeMinutes} min read · ${(currentSummary.wordCount||0).toLocaleString()} words`,
    ``,
    `📝 TOPIC\n${currentSummary.mainTopic}`,
    ``,
    `📋 SUMMARY`,
    ...(currentSummary.summary || []).map(s => `• ${s}`),
    ``,
    `⚡ KEY INSIGHTS`,
    ...(currentSummary.keyInsights || []).map((s, i) => `${i + 1}. ${s}`),
    `\n— AI Page Summarizer (Free Proxy)`
  ].join("\n");

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }

  const orig = els.btnCopy.innerHTML;
  els.btnCopy.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><polyline points="20 6 9 17 4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Copied!`;
  els.btnCopy.style.color = "var(--green)";
  setTimeout(() => { els.btnCopy.innerHTML = orig; els.btnCopy.style.color = ""; }, 1800);
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function openSettings()  { els.settingsOverlay.style.display = "flex"; els.btnCloseSettings.focus(); }
function closeSettings() { els.settingsOverlay.style.display = "none"; els.btnSettings.focus(); }

async function saveSettings() {
  await chrome.storage.sync.set({
    summaryLength:    els.selLength.value,
    highlightEnabled: els.chkHighlight.checked
  });
  els.saveFeedback.textContent = "✓ Saved!";
  els.saveFeedback.style.color = "var(--green)";
  els.saveFeedback.classList.add("visible");
  setTimeout(() => { els.saveFeedback.classList.remove("visible"); closeSettings(); }, 700);
}

// ─── Theme ────────────────────────────────────────────────────────────────────
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

// ─── Loading steps ────────────────────────────────────────────────────────────
function advanceLoadingStep(step) {
  const order = ["extract", "analyze", "format"];
  const idx = order.indexOf(step);
  order.forEach((s, i) => {
    const el = els.loadingSteps.querySelector(`[data-step="${s}"]`);
    if (!el) return;
    el.classList.toggle("active", i === idx);
    el.classList.toggle("done",   i < idx);
  });
}

// ─── Panels ───────────────────────────────────────────────────────────────────
function showPanel(panel) {
  els.emptyState.style.display   = panel === "empty"   ? "" : "none";
  els.loadingState.style.display = panel === "loading" ? "" : "none";
  els.errorState.style.display   = panel === "error"   ? "" : "none";
  els.results.style.display      = panel === "results" ? "" : "none";
}

function showLoading() {
  showPanel("loading");
  els.loadingText.textContent = "Reading page content…";
  els.coldStartHint.style.display = "none";
  advanceLoadingStep("extract");
  showActionButtons(false);
  els.btnSummarize.disabled = true;
}

function showError(msg) {
  clearTimeout(coldStartTimer);
  els.coldStartHint.style.display = "none";
  els.errorMessage.textContent = msg || "An error occurred.";
  showPanel("error");
  showActionButtons(false);
  els.btnSummarize.disabled = false;
}

function showActionButtons(hasResults) {
  els.btnSummarize.disabled    = false;
  els.btnClear.style.display   = hasResults ? "" : "none";
  els.btnCopy.style.display    = hasResults ? "" : "none";
  els.btnRefresh.style.display = hasResults ? "" : "none";
}

// ─── Security ─────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#x2F;/g, "/")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const sleep = ms => new Promise(r => setTimeout(r, ms));