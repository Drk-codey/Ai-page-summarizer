// Message listener 
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "EXTRACT_CONTENT") {
    try {
      const extracted = extractPageContent();
      sendResponse({ success: true, data: extracted });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return false; // sync
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

// Content extraction 
function extractPageContent() {
  const title = document.title || "";
  const url = window.location.href;

  // Attempt smart extraction in priority order
  const content =
    extractArticleContent() ||
    extractMainContent() ||
    extractBodyContent();

  const wordCount = content.split(/\s+/).filter(Boolean).length;

  return {
    title,
    url,
    content: content.slice(0, 15000), // cap at 15k chars
    wordCount,
    lang: document.documentElement.lang || "en",
    description: getMeta("description") || getMeta("og:description") || ""
  };
}

/**
 * Strategy 1: Look for semantic article containers
 */
function extractArticleContent() {
  const selectors = [
    "article[class*='post']",
    "article[class*='article']",
    "article[class*='content']",
    "article[class*='entry']",
    "article",
    "[role='article']",
    "[role='main'] article",
    ".post-content",
    ".article-content",
    ".entry-content",
    ".post-body",
    ".article-body",
    ".story-body",
    ".content-body",
    "#article-body",
    "#post-body",
    "#main-content article",
    ".single-post-content"
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) {
      const text = cleanNodeText(el);
      if (text.length > 300) return text;
    }
  }
  return null;
}

/**
 * Strategy 2: Use <main> or landmark roles
 */
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

/**
 * Strategy 3: Heuristic — find the densest text container
 */
function extractBodyContent() {
  // Score all block elements by text density
  const candidates = Array.from(
    document.querySelectorAll("div, section, .content, .body, .text")
  );

  let best = null;
  let bestScore = 0;

  for (const el of candidates) {
    // Skip known noise elements
    if (isNoiseElement(el)) continue;

    const text = cleanNodeText(el);
    const words = text.split(/\s+/).filter(Boolean).length;
    const paragraphs = el.querySelectorAll("p").length;
    const links = el.querySelectorAll("a").length;

    // Score: favor text-heavy, paragraph-rich, link-sparse elements
    const linkRatio = links / Math.max(words, 1);
    const score = words * (1 + paragraphs * 0.3) * (1 - Math.min(linkRatio, 0.8));

    if (score > bestScore && words > 100) {
      bestScore = score;
      best = el;
    }
  }

  return best ? cleanNodeText(best) : cleanNodeText(document.body);
}

// DOM helpers
/**
 * Clone node, remove all noise, extract clean text
 */
function cleanNodeText(el) {
  if (!el) return "";

  const clone = el.cloneNode(true);

  // Remove noise tags
  const noiseSelectors = [
    "script", "style", "noscript", "iframe", "object", "embed",
    "nav", "header", "footer", "aside", "form", "button",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']",
    "[role='complementary']", "[role='search']", "[role='form']",
    ".nav", ".navigation", ".navbar", ".header", ".footer", ".sidebar",
    ".widget", ".ad", ".advertisement", ".ads", ".social-share",
    ".share-buttons", ".comments", ".comment-section", ".related",
    ".related-posts", ".recommended", ".newsletter", ".popup",
    ".modal", ".cookie", ".gdpr", ".banner",
    "[aria-hidden='true']"
  ];

  for (const selector of noiseSelectors) {
    clone.querySelectorAll(selector).forEach(n => n.remove());
  }

  // Get text, collapse whitespace
  return clone.innerText || clone.textContent || "";
}

function isNoiseElement(el) {
  const tag = el.tagName?.toLowerCase();
  if (["nav", "header", "footer", "aside", "form"].includes(tag)) return true;

  const classAndId = `${el.className} ${el.id}`.toLowerCase();
  const noisePatterns = [
    "nav", "menu", "sidebar", "footer", "header", "widget",
    "ad-", "advertisement", "social", "share", "comment",
    "related", "recommended", "newsletter", "popup", "modal",
    "cookie", "banner", "toolbar", "breadcrumb"
  ];

  return noisePatterns.some(p => classAndId.includes(p));
}

function getMeta(name) {
  const el =
    document.querySelector(`meta[name="${name}"]`) ||
    document.querySelector(`meta[property="${name}"]`);
  return el?.getAttribute("content") || "";
}

// Highlight system 
const HIGHLIGHT_CLASS = "ai-summarizer-highlight";
const HIGHLIGHT_ATTR = "data-ai-highlight";

function highlightPhrases(phrases) {
  if (!Array.isArray(phrases) || phrases.length === 0) return;

  removeHighlights(); // clear previous

  // Inject styles if not already present
  injectHighlightStyles();

  const colors = ["#FFE082", "#A5D6A7", "#90CAF9"]; // yellow, green, blue

  phrases.forEach((phrase, idx) => {
    if (!phrase || phrase.length < 5) return;

    // Decode HTML entities from sanitized text
    const rawPhrase = decodeHTMLEntities(phrase);
    const color = colors[idx % colors.length];

    highlightTextInDOM(document.body, rawPhrase, color, idx);
  });

  // Scroll to first highlight
  const first = document.querySelector(`.${HIGHLIGHT_CLASS}`);
  if (first) {
    first.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function highlightTextInDOM(root, phrase, color, index) {
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        // Skip script/style nodes
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName?.toLowerCase();
        if (["script", "style", "noscript"].includes(tag)) return NodeFilter.FILTER_REJECT;
        // Skip already-highlighted
        if (parent.classList?.contains(HIGHLIGHT_CLASS)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const matches = [];
  let node;

  const lowerPhrase = phrase.toLowerCase();

  while ((node = walker.nextNode())) {
    const lowerText = node.textContent.toLowerCase();
    const matchIdx = lowerText.indexOf(lowerPhrase);
    if (matchIdx !== -1) {
      matches.push({ node, matchIdx });
      if (matches.length >= 2) break; // limit per phrase
    }
  }

  matches.forEach(({ node: textNode, matchIdx }) => {
    try {
      const range = document.createRange();
      range.setStart(textNode, matchIdx);
      range.setEnd(textNode, matchIdx + phrase.length);

      const mark = document.createElement("mark");
      mark.className = HIGHLIGHT_CLASS;
      mark.setAttribute(HIGHLIGHT_ATTR, String(index));
      mark.style.cssText = `
        background-color: ${color} !important;
        color: inherit !important;
        padding: 2px 4px !important;
        border-radius: 3px !important;
        box-shadow: 0 1px 3px rgba(0,0,0,0.2) !important;
      `;

      range.surroundContents(mark);
    } catch {
      // Range may span multiple nodes — skip gracefully
    }
  });
}

function removeHighlights() {
  const highlights = document.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
  highlights.forEach(mark => {
    const parent = mark.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    }
  });
}

function injectHighlightStyles() {
  const existingStyle = document.getElementById("ai-summarizer-styles");
  if (existingStyle) return;

  const style = document.createElement("style");
  style.id = "ai-summarizer-styles";
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      transition: background-color 0.3s ease;
      cursor: pointer;
    }
    .${HIGHLIGHT_CLASS}:hover {
      filter: brightness(0.9);
    }
    @keyframes ai-highlight-pulse {
      0% { opacity: 1; }
      50% { opacity: 0.7; }
      100% { opacity: 1; }
    }
    .${HIGHLIGHT_CLASS}[${HIGHLIGHT_ATTR}="0"] {
      animation: ai-highlight-pulse 1s ease-in-out 2;
    }
  `;
  document.head.appendChild(style);
}

function decodeHTMLEntities(str) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = str;
  return textarea.value;
}