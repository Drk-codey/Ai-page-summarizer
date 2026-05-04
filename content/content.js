chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "EXTRACT_CONTENT") {
    try {
      sendResponse({ success: true, data: extractPageContent() });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return false;
  }

  if (message.type === "HIGHLIGHT_PHRASES") {
    try {
      highlightPhrases(message.payload.phrases);
      sendResponse({ success: true });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return false;
  }

  if (message.type === "REMOVE_HIGHLIGHTS") {
    removeHighlights();
    sendResponse({ success: true });
    return false;
  }

  return false;
});

// ─── Content extraction ───────────────────────────────────────────────────────
function extractPageContent() {
  const title   = document.title || "";
  const url     = window.location.href;
  const content = extractArticleContent() || extractMainContent() || extractBodyContent();
  const wordCount = content.split(/\s+/).filter(Boolean).length;

  return {
    title,
    url,
    content:     content.slice(0, 15_000),
    wordCount,
    lang:        document.documentElement.lang || "en",
    description: getMeta("description") || getMeta("og:description") || ""
  };
}

/** Strategy 1 — semantic article selectors */
function extractArticleContent() {
  const selectors = [
    "article[class*='post']", "article[class*='article']", "article[class*='content']",
    "article[class*='entry']", "article", "[role='article']", "[role='main'] article",
    ".post-content", ".article-content", ".entry-content", ".post-body",
    ".article-body", ".story-body", ".content-body",
    "#article-body", "#post-body", "#main-content article"
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const text = cleanNodeText(el);
      if (text.length > 300) return text;
    }
  }
  return null;
}

/** Strategy 2 — landmark / main element */
function extractMainContent() {
  const candidates = [
    document.querySelector("main"),
    document.querySelector("[role='main']"),
    document.querySelector("#main"),
    document.querySelector("#content"),
    document.querySelector(".main-content"),
    document.querySelector(".page-content")
  ].filter(Boolean);

  for (const el of candidates) {
    const text = cleanNodeText(el);
    if (text.length > 300) return text;
  }
  return null;
}

/** Strategy 3 — text-density scoring */
function extractBodyContent() {
  const candidates = Array.from(
    document.querySelectorAll("div, section, .content, .body, .text")
  );

  let best = null, bestScore = 0;

  for (const el of candidates) {
    if (isNoiseElement(el)) continue;
    const text       = cleanNodeText(el);
    const words      = text.split(/\s+/).filter(Boolean).length;
    const paragraphs = el.querySelectorAll("p").length;
    const links      = el.querySelectorAll("a").length;
    const linkRatio  = links / Math.max(words, 1);
    const score      = words * (1 + paragraphs * 0.3) * (1 - Math.min(linkRatio, 0.8));

    if (score > bestScore && words > 100) { bestScore = score; best = el; }
  }

  return best ? cleanNodeText(best) : cleanNodeText(document.body);
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────
function cleanNodeText(el) {
  if (!el) return "";
  const clone = el.cloneNode(true);

  const noiseSelectors = [
    "script","style","noscript","iframe","object","embed",
    "nav","header","footer","aside","form","button",
    "[role='navigation']","[role='banner']","[role='contentinfo']",
    "[role='complementary']","[role='search']","[role='form']",
    ".nav",".navigation",".navbar",".header",".footer",".sidebar",
    ".widget",".ad",".advertisement",".ads",".social-share",
    ".share-buttons",".comments",".comment-section",".related",
    ".related-posts",".recommended",".newsletter",".popup",
    ".modal",".cookie",".gdpr",".banner","[aria-hidden='true']"
  ];
  for (const sel of noiseSelectors) {
    clone.querySelectorAll(sel).forEach(n => n.remove());
  }
  return (clone.innerText || clone.textContent || "").replace(/\s{3,}/g, "\n\n").trim();
}

function isNoiseElement(el) {
  const tag = el.tagName?.toLowerCase();
  if (["nav","header","footer","aside","form"].includes(tag)) return true;
  const classAndId = `${el.className} ${el.id}`.toLowerCase();
  return ["nav","menu","sidebar","footer","header","widget","ad-",
          "advertisement","social","share","comment","related",
          "recommended","newsletter","popup","modal","cookie",
          "banner","toolbar","breadcrumb"].some(p => classAndId.includes(p));
}

function getMeta(name) {
  const el = document.querySelector(`meta[name="${name}"]`)
          || document.querySelector(`meta[property="${name}"]`);
  return el?.getAttribute("content") || "";
}

// ─── Highlight system ─────────────────────────────────────────────────────────
const HIGHLIGHT_CLASS = "ai-summarizer-highlight";

function highlightPhrases(phrases) {
  if (!Array.isArray(phrases) || !phrases.length) return;
  removeHighlights();
  injectHighlightStyles();

  const colors = ["#FFE082", "#A5D6A7", "#90CAF9"];

  phrases.forEach((phrase, idx) => {
    if (!phrase || phrase.length < 5) return;
    highlightTextInDOM(document.body, decodeHTMLEntities(phrase), colors[idx % colors.length], idx);
  });

  document.querySelector(`.${HIGHLIGHT_CLASS}`)
    ?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function highlightTextInDOM(root, phrase, color, index) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName?.toLowerCase();
      if (["script","style","noscript"].includes(tag)) return NodeFilter.FILTER_REJECT;
      if (parent.classList?.contains(HIGHLIGHT_CLASS))  return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const lowerPhrase = phrase.toLowerCase();
  const matches = [];
  let node;

  while ((node = walker.nextNode())) {
    const idx = node.textContent.toLowerCase().indexOf(lowerPhrase);
    if (idx !== -1) { matches.push({ node, idx }); if (matches.length >= 2) break; }
  }

  matches.forEach(({ node: textNode, idx: matchIdx }) => {
    try {
      const range = document.createRange();
      range.setStart(textNode, matchIdx);
      range.setEnd(textNode, matchIdx + phrase.length);

      const mark = document.createElement("mark");
      mark.className = HIGHLIGHT_CLASS;
      mark.setAttribute("data-ai-highlight", String(index));
      mark.style.cssText = `
        background-color:${color}!important;color:inherit!important;
        padding:2px 4px!important;border-radius:3px!important;
        box-shadow:0 1px 3px rgba(0,0,0,0.2)!important;
      `;
      range.surroundContents(mark);
    } catch { /* range spans multiple nodes — skip */ }
  });
}

function removeHighlights() {
  document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(mark => {
    const parent = mark.parentNode;
    if (parent) { parent.replaceChild(document.createTextNode(mark.textContent), mark); parent.normalize(); }
  });
}

function injectHighlightStyles() {
  if (document.getElementById("ai-summarizer-styles")) return;
  const style = document.createElement("style");
  style.id = "ai-summarizer-styles";
  style.textContent = `
    .${HIGHLIGHT_CLASS} { transition: background-color .3s ease; cursor: pointer; }
    .${HIGHLIGHT_CLASS}:hover { filter: brightness(.9); }
    @keyframes ai-pulse { 0%,100%{opacity:1} 50%{opacity:.7} }
    .${HIGHLIGHT_CLASS}[data-ai-highlight="0"] { animation: ai-pulse 1s ease-in-out 2; }
  `;
  document.head.appendChild(style);
}

function decodeHTMLEntities(str) {
  const ta = document.createElement("textarea");
  ta.innerHTML = str;
  return ta.value;
}