(() => {
  // extension-showcasetool/src/replay/divergence.ts
  var DEFAULT_CONFIG = { offPathBeforeEscalation: 3, idleMs: 45e3 };
  var ACTIONABLE = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox],[role=radio]";
  function isOrienting(el) {
    const role = el.getAttribute("role");
    if (role && ["menu", "menubar", "menuitem", "tab", "tablist", "combobox", "listbox", "option", "search"].includes(role)) return true;
    if (el.closest("[role=menu],[role=menubar],[role=listbox],[role=tablist],[aria-haspopup=true],details,summary")) return true;
    if (el.hasAttribute("aria-expanded")) return true;
    if (el.tagName === "LABEL") return true;
    return false;
  }
  var DivergenceTracker = class {
    constructor(config = DEFAULT_CONFIG) {
      this.config = config;
    }
    config;
    offPathStreak = 0;
    lastQualifyingEvent = Date.now();
    reset() {
      this.offPathStreak = 0;
      this.lastQualifyingEvent = Date.now();
    }
    markActivity() {
      this.lastQualifyingEvent = Date.now();
    }
    /** True when no qualifying event has happened for long enough to offer help. */
    isStuck() {
      return Date.now() - this.lastQualifyingEvent > this.config.idleMs;
    }
    get streak() {
      return this.offPathStreak;
    }
    shouldEscalate() {
      return this.offPathStreak >= this.config.offPathBeforeEscalation;
    }
    /**
     * Classify one interaction against the expected step.
     *
     * `expected` is null when the step could not be resolved on this page — in that case we
     * have no idea what the right target was, so nothing can be called off-path.
     */
    classify(event, step, expected) {
      const target = event.target;
      if (!(target instanceof Element)) return "harmless";
      if (expected && (target === expected || expected.contains(target) || target.contains(expected))) {
        this.offPathStreak = 0;
        this.markActivity();
        return "on-path";
      }
      if (event.type !== "click" && event.type !== "submit") {
        return "harmless";
      }
      const actionable = target.closest(ACTIONABLE);
      if (!actionable) {
        return "harmless";
      }
      if (isOrienting(actionable)) {
        this.markActivity();
        return "harmless";
      }
      if (step.a11y.name && looseNameMatch(actionable, step.a11y.name)) {
        this.offPathStreak = 0;
        this.markActivity();
        return "on-path";
      }
      this.offPathStreak += 1;
      this.markActivity();
      return "off-path";
    }
    /**
     * URL check. Intermediate pages are extremely common in OAuth flows — consent screens,
     * interstitials, redirects — so a mismatch alone is not enough to block someone.
     */
    classifyUrl(step, currentUrl, allPatterns) {
      if (!step.urlPattern) return "on-path";
      if (matchesPattern(currentUrl, step.urlPattern)) return "on-path";
      if (allPatterns.some((pattern) => matchesPattern(currentUrl, pattern))) return "harmless";
      try {
        if (new URL(currentUrl).hostname === new URL(step.urlPattern).hostname) return "harmless";
      } catch {
        return "harmless";
      }
      return "wrong-page";
    }
  };
  function looseNameMatch(el, expected) {
    const name = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    const wanted = expected.replace(/\s+/g, " ").trim().toLowerCase();
    if (!name || !wanted) return false;
    return name === wanted || wanted.length >= 4 && (name.includes(wanted) || wanted.includes(name));
  }
  function matchesPattern(url, pattern) {
    try {
      const live = new URL(url);
      const wanted = new URL(pattern);
      if (live.origin !== wanted.origin) return false;
      const liveParts = live.pathname.split("/").filter(Boolean);
      const wantedParts = wanted.pathname.split("/").filter(Boolean);
      if (!wantedParts.length) return true;
      if (liveParts.length < wantedParts.length) return false;
      return wantedParts.every((part, index) => part.startsWith(":") || part === liveParts[index]);
    } catch {
      return url === pattern;
    }
  }
  function verifyPasses(step) {
    if (!step.verify) return false;
    const { kind, value } = step.verify;
    try {
      switch (kind) {
        case "urlMatches":
          return location.href.includes(value) || matchesPattern(location.href, value);
        case "selectorPresent":
          return !!document.querySelector(value);
        case "selectorAbsent":
          return !document.querySelector(value);
        case "textPresent":
          return (document.body?.innerText ?? "").toLowerCase().includes(value.toLowerCase());
        case "manual":
          return false;
      }
    } catch {
      return false;
    }
  }

  // extension-showcasetool/src/replay/overlay.ts
  var HOST_ID = "oneshowcasetool-overlay-host";
  var STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }

.layer { position: fixed; inset: 0; z-index: 2147483600; pointer-events: none; }

/**
 * The spotlight is a filled scrim with a hole in it, not a ring \u2014 same primitive as a
 * redaction fill. The cyan edge is the only saturated thing on the page, which is what makes
 * "look here" work without an animation.
 */
.spot { position: fixed; border-radius: 4px;
        box-shadow: 0 0 0 3px rgba(34,184,214,.85), 0 0 0 9999px rgba(7,10,14,.55);
        transition: top .18s ease, left .18s ease, width .18s ease, height .18s ease; pointer-events: none; }
.spot.lost { box-shadow: 0 0 0 9999px rgba(7,10,14,.55); }

.arrow { position: fixed; width: 44px; height: 44px; pointer-events: none;
         transition: top .18s ease, left .18s ease; filter: drop-shadow(0 2px 6px rgba(0,0,0,.5)); }
.arrow svg { display: block; width: 100%; height: 100%; }
@keyframes bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
.arrow.bob { animation: bob 1.1s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .arrow.bob { animation: none; }
  .spot, .card, .arrow { transition: none; }
}

/**
 * A hard left edge in the phase colour instead of a full border. The card reads as something
 * clipped to the page by the guide, rather than as another dialog the site might have opened.
 */
.card { position: fixed; width: min(370px, calc(100vw - 32px)); background: #0b0e14; color: #e6edf3;
        border: 1px solid #1e2733; border-left: 3px solid #22b8d6; border-radius: 6px;
        padding: 13px 16px 12px; pointer-events: auto;
        box-shadow: 0 20px 56px rgba(0,0,0,.55); font-size: 14px; line-height: 1.5;
        transition: top .18s ease, left .18s ease; }

.head { display: flex; align-items: baseline; gap: 9px; margin-bottom: 7px; }

/**
 * The step counter is the one condensed, tracked element \u2014 a guide is genuinely an ordered
 * trace, so a numeral here encodes real information rather than decorating the card.
 */
.count { font-family: "Bahnschrift","Avenir Next Condensed","Roboto Condensed","Segoe UI",sans-serif;
         font-size: 11px; font-weight: 700; letter-spacing: .13em; text-transform: uppercase;
         color: #22b8d6; font-variant-numeric: tabular-nums; }
.via { margin-left: auto; font-size: 10px; color: #77848f; letter-spacing: .06em; text-transform: uppercase; }

h2 { margin: 0 0 6px; font-size: 15px; font-weight: 600; line-height: 1.35; letter-spacing: -.005em; }
p { margin: 0 0 10px; color: #c3cdd6; }

/**
 * Notices are filled blocks, not tinted outlines. A correction has to land in peripheral
 * vision while the Follower is looking at the page, not at us.
 */
.notice { border-radius: 4px; padding: 8px 10px; margin: 0 0 10px; font-size: 13px; font-weight: 500; }
.notice.info { background: rgba(34,184,214,.14); box-shadow: inset 3px 0 0 #22b8d6; color: #8fe9fa; }
.notice.warn { background: rgba(245,165,36,.14); box-shadow: inset 3px 0 0 #f5a524; color: #ffd694; }
.notice.block { background: rgba(232,69,63,.15); box-shadow: inset 3px 0 0 #e8453f; color: #ff9e96; }

.why { margin: 0 0 10px; }
.why summary { cursor: pointer; color: #22b8d6; font-size: 12.5px; outline: none; }
.why summary:focus-visible { outline: 2px solid #22b8d6; outline-offset: 2px; border-radius: 2px; }
.why p { margin: 6px 0 0; font-size: 13px; color: #93a1ae; }

/**
 * The consent block is the one moment this overlay touches the Follower's own secret, so it
 * is the most emphatic surface here: paper-dark, a full cyan edge, and the value shown masked
 * and monospaced so it reads as data rather than prose.
 */
.consent { background: #070a0e; box-shadow: inset 3px 0 0 #22b8d6; border-radius: 4px;
           padding: 10px 12px; margin: 0 0 10px; }
.consent .val { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: #e6edf3;
                background: #0b0e14; border: 1px solid #1e2733; border-radius: 3px; padding: 3px 7px;
                display: inline-block; margin: 6px 0; letter-spacing: .02em; }
.consent .dest { font-size: 12px; color: #93a1ae; }

.row { display: flex; gap: 8px; flex-wrap: wrap; }
button { font: inherit; font-size: 13px; border-radius: 4px; padding: 6px 13px; cursor: pointer;
         border: 1px solid transparent; font-weight: 500; }
button:focus-visible { outline: 2px solid #22b8d6; outline-offset: 2px; }
button.primary { background: #22b8d6; color: #070a0e; font-weight: 650; }
button.primary:hover { background: #5ee0f5; }
button.ghost { background: transparent; color: #93a1ae; border-color: #1e2733; }
button.ghost:hover { color: #e6edf3; border-color: #2e3b4a; }
button.danger { background: transparent; color: #ff9e96; border-color: rgba(232,69,63,.46); }
button.danger:hover { background: rgba(232,69,63,.15); }
.ask { margin: 0 0 10px; }
.ask input { width: 100%; font: inherit; font-size: 13px; background: #070a0e; color: #e6edf3;
             border: 1px solid #1e2733; border-radius: 4px; padding: 6px 8px; }
.ask-answer { margin: 8px 0 0; font-size: 13px; color: #c3cdd6; }
`;
  var Overlay = class {
    host = null;
    root = null;
    layer;
    spot;
    arrow;
    card;
    target = null;
    reposition = () => this.position();
    mount() {
      if (this.host) return;
      this.host = document.createElement("div");
      this.host.id = HOST_ID;
      this.root = this.host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = STYLE;
      this.layer = document.createElement("div");
      this.layer.className = "layer";
      this.spot = document.createElement("div");
      this.spot.className = "spot";
      this.arrow = document.createElement("div");
      this.arrow.className = "arrow bob";
      this.arrow.innerHTML = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3v14m0 0 6-6m-6 6-6-6" stroke="#22b8d6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
      this.card = document.createElement("div");
      this.card.className = "card";
      this.layer.append(this.spot, this.arrow);
      this.root.append(style, this.layer, this.card);
      document.documentElement.append(this.host);
      window.addEventListener("scroll", this.reposition, true);
      window.addEventListener("resize", this.reposition);
    }
    unmount() {
      window.removeEventListener("scroll", this.reposition, true);
      window.removeEventListener("resize", this.reposition);
      this.host?.remove();
      this.host = null;
      this.root = null;
      this.target = null;
    }
    get mounted() {
      return this.host !== null;
    }
    /** Point at an element, or at nothing when the step could not be resolved. */
    anchor(element) {
      this.target = element;
      if (element) {
        const box = element.getBoundingClientRect();
        const offscreen = box.top < 0 || box.bottom > window.innerHeight;
        if (offscreen) element.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      this.position();
    }
    render(content) {
      if (!this.card) return;
      const notice = content.notice ? `<div class="notice ${content.notice.tone}">${escapeHtml(content.notice.text)}</div>` : "";
      const bodyBlock = content.consent ? (
        /**
         * An arrow to a destination is not consent. This is the only path by which a value moves,
         * so the prompt names where it goes *and* what does not happen to it on the way — the
         * value lives in a local variable for the length of this prompt and is blanked straight
         * after, and it never reaches the guide file or this extension's storage.
         */
        `<div class="consent">
           <div>${escapeHtml(content.consent.text)}</div>
           <div class="val">${escapeHtml(content.consent.masked)}</div>
           <div class="dest">Goes to <strong>${escapeHtml(content.consent.destination)}</strong> on this machine.
             It is not stored by 1ShowcaseTool, and it is never written into the guide.</div>
         </div>`
      ) : content.body ? `<p>${escapeHtml(content.body)}</p>` : "";
      const why = content.why ? `<details class="why"><summary>Why this step exists</summary><p>${escapeHtml(content.why)}</p></details>` : "";
      const ask2 = content.ask ? `<form class="ask">
           <input name="q" type="text" maxlength="500" placeholder="Ask this guide\u2026" value="${escapeHtml(content.ask.question)}" ${content.ask.busy ? "disabled" : ""} />
           ${content.ask.answer ? `<p class="ask-answer">${escapeHtml(content.ask.answer)}</p>` : ""}
         </form>` : "";
      this.card.innerHTML = `
      <div class="head">
        <span class="count">Step ${content.stepNumber} of ${content.stepTotal}</span>
        ${content.resolvedVia === "ai" ? '<span class="via">found by AI</span>' : ""}
        ${content.resolvedVia === "a11y" ? '<span class="via">approximate</span>' : ""}
      </div>
      <h2>${escapeHtml(content.title)}</h2>
      ${notice}
      ${bodyBlock}
      ${why}
      ${ask2}
      <div class="row"></div>`;
      const form = this.card.querySelector("form.ask");
      if (form && content.ask) {
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          const input = form.querySelector("input");
          const value = input?.value.trim() ?? "";
          if (value) content.ask?.onSubmit(value);
        });
      }
      const row = this.card.querySelector(".row");
      for (const action of content.actions) {
        const button = document.createElement("button");
        button.className = action.kind;
        button.textContent = action.label;
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          action.onClick();
        });
        row.append(button);
      }
      this.position();
    }
    position() {
      if (!this.host) return;
      if (!this.target || !this.target.isConnected) {
        this.spot.classList.add("lost");
        this.arrow.style.opacity = "0";
        this.spot.style.width = "0px";
        this.spot.style.height = "0px";
        this.placeCardFallback();
        return;
      }
      const box = this.target.getBoundingClientRect();
      this.spot.classList.remove("lost");
      this.spot.style.top = `${box.top - 4}px`;
      this.spot.style.left = `${box.left - 4}px`;
      this.spot.style.width = `${box.width + 8}px`;
      this.spot.style.height = `${box.height + 8}px`;
      const above = box.top > 70;
      this.arrow.style.opacity = "1";
      this.arrow.style.left = `${box.left + box.width / 2 - 22}px`;
      this.arrow.style.top = above ? `${box.top - 52}px` : `${box.bottom + 10}px`;
      this.arrow.style.transform = above ? "rotate(0deg)" : "rotate(180deg)";
      const cardBox = this.card.getBoundingClientRect();
      const cardHeight = cardBox.height || 190;
      const cardWidth = cardBox.width || 360;
      let top = above ? box.top - 52 - cardHeight - 8 : box.bottom + 62;
      if (top < 12) top = Math.min(box.bottom + 62, window.innerHeight - cardHeight - 12);
      if (top + cardHeight > window.innerHeight - 12) top = Math.max(12, window.innerHeight - cardHeight - 12);
      let left = box.left + box.width / 2 - cardWidth / 2;
      left = Math.max(12, Math.min(left, window.innerWidth - cardWidth - 12));
      this.card.style.top = `${top}px`;
      this.card.style.left = `${left}px`;
    }
    /** Nothing to point at — dock the card so the step text is still usable. */
    placeCardFallback() {
      const cardBox = this.card.getBoundingClientRect();
      this.card.style.left = `${Math.max(12, window.innerWidth - (cardBox.width || 360) - 16)}px`;
      this.card.style.top = `${window.innerHeight - (cardBox.height || 190) - 16}px`;
    }
    /** True when the event came from our own UI, so the divergence detector ignores it. */
    ownsEvent(event) {
      const path = event.composedPath();
      return !!this.host && path.includes(this.host);
    }
  };
  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }

  // extension-showcasetool/src/replay/resolve.ts
  var ROLE_NAME_RE = /^role=([a-zA-Z-]+)\[name="(.*)"\]$/s;
  var TEXT_RE = /^text=(.*)$/s;
  function isVisible(el) {
    if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return false;
    const box = el.getBoundingClientRect();
    if (box.width <= 0 && box.height <= 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  }
  function normalize(value) {
    return value.replace(/\s+/g, " ").trim().toLowerCase();
  }
  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit?.trim()) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case "a":
        return el.hasAttribute("href") ? "link" : "generic";
      case "button":
        return "button";
      case "select":
        return "combobox";
      case "textarea":
        return "textbox";
      case "input": {
        const type = el.type;
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "submit" || type === "button" || type === "reset") return "button";
        return "textbox";
      }
      default:
        return tag;
    }
  }
  function nameOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria?.trim()) return aria.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const labels = el.labels;
      if (labels?.length) {
        const text = Array.from(labels).map((l) => l.textContent?.trim() ?? "").filter(Boolean).join(" ");
        if (text) return text;
      }
      const placeholder = el.getAttribute("placeholder");
      if (placeholder?.trim()) return placeholder.trim();
    }
    const title = el.getAttribute("title");
    if (title?.trim()) return title.trim();
    return (el.textContent ?? "").replace(/\s+/g, " ").trim();
  }
  var INTERACTIVE = "a,button,input,select,textarea,summary,[role],[onclick],[tabindex]";
  function resolveSelector(selector) {
    const roleName = ROLE_NAME_RE.exec(selector);
    if (roleName) {
      const [, role, name] = roleName;
      const wanted = normalize(name);
      const matches = Array.from(document.querySelectorAll(INTERACTIVE)).filter(
        (el) => isVisible(el) && roleOf(el) === role && normalize(nameOf(el)) === wanted
      );
      return matches.length === 1 ? matches[0] : matches[0] ?? null;
    }
    const textMatch = TEXT_RE.exec(selector);
    if (textMatch) {
      const wanted = normalize(textMatch[1]);
      if (!wanted) return null;
      const candidates = Array.from(document.querySelectorAll(INTERACTIVE)).filter((el) => isVisible(el) && normalize(nameOf(el)) === wanted);
      if (candidates.length) {
        return candidates.reduce((best, el) => best.contains(el) ? el : best);
      }
      return null;
    }
    try {
      const matches = Array.from(document.querySelectorAll(selector)).filter(isVisible);
      return matches.length ? matches[0] : null;
    } catch {
      return null;
    }
  }
  function resolveByAnchor(anchor) {
    if (!anchor.name) return null;
    const wanted = normalize(anchor.name);
    const scored = Array.from(document.querySelectorAll(INTERACTIVE)).filter(isVisible).map((el) => {
      const name = normalize(nameOf(el));
      let score = 0;
      if (name === wanted) score += 10;
      else if (name.includes(wanted) || wanted.includes(name)) score += 4;
      else return null;
      if (anchor.role && roleOf(el) === anchor.role) score += 3;
      if (anchor.landmark && el.closest("main,nav,header,footer,aside,form,[role]")) score += 1;
      return { el, score };
    }).filter((x) => x !== null).sort((a, b) => b.score - a.score);
    return scored.length && scored[0].score >= 4 ? scored[0].el : null;
  }
  function a11ySnapshot(limit = 120) {
    const rows = [];
    for (const el of Array.from(document.querySelectorAll(INTERACTIVE))) {
      if (!isVisible(el)) continue;
      const name = nameOf(el).slice(0, 80);
      if (!name) continue;
      const ref = stableRef(el);
      if (!ref) continue;
      rows.push(`${rows.length}. role=${roleOf(el)} name="${name}" ref=${ref}`);
      if (rows.length >= limit) break;
    }
    return rows.join("\n");
  }
  function stableRef(el) {
    for (const attr of ["data-testid", "data-test-id", "data-qa"]) {
      const value = el.getAttribute(attr);
      if (value) return `[${attr}="${value}"]`;
    }
    const id = el.getAttribute("id");
    if (id) return `#${CSS.escape(id)}`;
    const aria = el.getAttribute("aria-label");
    if (aria) return `${el.tagName.toLowerCase()}[aria-label="${aria}"]`;
    const name = nameOf(el);
    return name && name.length <= 60 ? `text=${name}` : null;
  }
  async function resolveStep(step, repair) {
    for (const selector of [...step.selectors, ...step.altSelectors ?? []]) {
      const el = resolveSelector(selector);
      if (el) return { element: el, via: "selector", selector };
    }
    const byAnchor = resolveByAnchor(step.a11y);
    if (byAnchor) return { element: byAnchor, via: "a11y" };
    if (repair) {
      const intent = [step.title, step.a11y.name ? `target labelled "${step.a11y.name}"` : "", step.body].filter(Boolean).join(" \u2014 ");
      const selector = await repair(a11ySnapshot(), intent);
      if (selector) {
        const el = resolveSelector(selector);
        if (el) return { element: el, via: "ai", selector };
      }
    }
    return null;
  }

  // extension-showcasetool/src/shared/redactionPatterns.ts
  var SENSITIVE_FIELD_RE = /secret|token|key|password|passwd|apikey|client_secret|private_key/i;
  var NEVER_STORE_INPUT_TYPES = ["password"];
  var NEVER_STORE_AUTOCOMPLETE_RE = /^(cc-|one-time-code$)/i;
  var CREDENTIAL_SHAPES = [
    { rule: "auto:private-key-block", label: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
    { rule: "auto:private-key-header", label: "PEM private key header", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
    { rule: "auto:key-prefix", label: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
    { rule: "auto:key-prefix", label: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
    { rule: "auto:key-prefix", label: "Google API key", re: /\bAIza[A-Za-z0-9_-]{20,}\b/g },
    { rule: "auto:key-prefix", label: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
    { rule: "auto:key-prefix", label: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
    { rule: "auto:key-prefix", label: "Stripe key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
    { rule: "auto:jwt", label: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g }
  ];
  function detectSecrets(text) {
    const found = [];
    for (const shape of CREDENTIAL_SHAPES) {
      const re = new RegExp(shape.re.source, shape.re.flags);
      let match;
      while ((match = re.exec(text)) !== null) {
        found.push({ rule: shape.rule, label: shape.label, start: match.index, end: match.index + match[0].length, text: match[0] });
        if (match[0].length === 0) re.lastIndex += 1;
      }
    }
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const item of found) {
      const prev = merged[merged.length - 1];
      if (prev && item.start < prev.end) continue;
      merged.push(item);
    }
    return merged;
  }
  function isSensitiveFieldName(...parts) {
    return parts.some((p) => !!p && SENSITIVE_FIELD_RE.test(p));
  }

  // extension-showcasetool/src/replay/reshoot.ts
  function reshootFills() {
    const rects = [];
    for (const field of Array.from(document.querySelectorAll("input, textarea"))) {
      const type = field instanceof HTMLInputElement ? (field.type ?? "").toLowerCase() : "textarea";
      const autocomplete = field.getAttribute("autocomplete") ?? "";
      const sensitive = NEVER_STORE_INPUT_TYPES.includes(type) || NEVER_STORE_AUTOCOMPLETE_RE.test(autocomplete) || !!field.value || isSensitiveFieldName(field.getAttribute("name"), field.getAttribute("id"), field.getAttribute("aria-label"));
      if (!sensitive) continue;
      const rect = visibleRect(field);
      if (rect) rects.push(rect);
    }
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const text = node.nodeValue ?? "";
      if (text.trim().length >= 12) {
        for (const hit of detectSecrets(text)) {
          const rect = rectForTextRange(node, hit.start, hit.end);
          if (rect) rects.push(rect);
        }
      }
      node = walker.nextNode();
    }
    return rects;
  }
  function reshootCrop(el) {
    const fills = reshootFills();
    const box = el?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) {
      return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight, fills };
    }
    const pad = 120;
    return {
      x: Math.max(0, box.left - pad),
      y: Math.max(0, box.top - pad),
      width: Math.min(window.innerWidth, box.width + pad * 2),
      height: Math.min(window.innerHeight, box.height + pad * 2),
      fills,
      target: { x: box.left, y: box.top, width: box.width, height: box.height }
    };
  }
  function visibleRect(el) {
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    if (box.bottom < 0 || box.right < 0 || box.top > window.innerHeight || box.left > window.innerWidth) return null;
    return { x: box.left, y: box.top, width: box.width, height: box.height, fills: [] };
  }
  function rectForTextRange(node, start, end) {
    try {
      const range = document.createRange();
      range.setStart(node, Math.max(0, start));
      range.setEnd(node, Math.min(node.length, end));
      const box = range.getBoundingClientRect();
      range.detach();
      if (box.width <= 0 || box.height <= 0) return null;
      if (box.bottom < 0 || box.right < 0 || box.top > window.innerHeight || box.left > window.innerWidth) return null;
      return { x: box.left - 2, y: box.top - 2, width: box.width + 4, height: box.height + 4, fills: [] };
    } catch {
      return null;
    }
  }

  // extension-showcasetool/src/replay/harvest.ts
  function readOutput(output) {
    const el = findElement(output.selector);
    if (!el) return null;
    const value = extractValue(el);
    if (!value || value.length > 8192) return null;
    return { output, value };
  }
  function findElement(selector) {
    const textMatch = /^text=(.*)$/s.exec(selector);
    if (textMatch) {
      const wanted = textMatch[1].replace(/\s+/g, " ").trim().toLowerCase();
      return Array.from(document.querySelectorAll("*")).find(
        (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase() === wanted && el.children.length === 0
      ) ?? null;
    }
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }
  function extractValue(el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value.trim();
    if (el instanceof HTMLSelectElement) return el.value.trim();
    const attr = el.getAttribute("data-value") ?? el.getAttribute("value");
    if (attr) return attr.trim();
    return (el.textContent ?? "").trim();
  }
  function maskForDisplay(value, sensitive) {
    if (!sensitive) return value.length <= 64 ? value : `${value.slice(0, 61)}\u2026`;
    if (value.length <= 6) return "\u2022".repeat(value.length);
    return `${value.slice(0, 4)}${"\u2022".repeat(Math.min(10, Math.max(4, value.length - 8)))}${value.slice(-2)}`;
  }
  function describeTarget(target) {
    const match = /^connector:([a-z0-9_-]+)\/([a-z0-9_-]+)$/i.exec(target);
    if (!match) return target;
    const connector = match[1].replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const field = match[2].replace(/[-_]/g, " ");
    return `${connector} \u2192 ${field}`;
  }
  async function deliverOnce(candidate, deliver) {
    const value = candidate.value;
    candidate.value = "";
    try {
      const result = await deliver(candidate.output.target, value, !!candidate.output.sensitive);
      return result;
    } finally {
    }
  }

  // extension-showcasetool/src/replay/index.ts
  var GUARD = "__oneshowcasetoolReplay";
  function ask(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          void chrome.runtime.lastError;
          resolve(response);
        });
      } catch {
        resolve(void 0);
      }
    });
  }
  function main() {
    const scope = globalThis;
    if (scope[GUARD]) return;
    scope[GUARD] = true;
    const overlay = new Overlay();
    const tracker = new DivergenceTracker();
    let guide = null;
    let index = 0;
    let mode = "follow";
    let resolution = null;
    let notice;
    let consent = null;
    let harvestDone = /* @__PURE__ */ new Set();
    let repairing = false;
    let tickTimer = null;
    let askQuestion = "";
    let askAnswer = "";
    let askBusy = false;
    const step = () => guide ? guide.steps[index] ?? null : null;
    function reportHealth(current, repaired) {
      if (mode !== "check" || !guide) return;
      void ask({
        type: "replay:step-health",
        guideId: guide.id,
        stepId: current.id,
        health: {
          via: resolution?.via ?? "none",
          selectorIndex: resolution?.via === "selector" && resolution.selector ? current.selectors.indexOf(resolution.selector) : -1,
          urlMatched: !current.urlPattern || matchesPattern(location.href, current.urlPattern),
          repaired
        }
      });
    }
    function draw() {
      const current = step();
      if (!guide || !current) return;
      const actions = [];
      if (consent) {
        actions.push(
          { label: "Send it", kind: "primary", onClick: () => void confirmHarvest() },
          { label: "Not now", kind: "ghost", onClick: () => declineHarvest() }
        );
        overlay.render({
          stepNumber: index + 1,
          stepTotal: guide.steps.length,
          title: current.title,
          body: "",
          why: current.why,
          notice,
          resolvedVia: resolution?.via,
          consent: {
            text: `Send ${consent.output.name} to your app?`,
            masked: maskForDisplay(consent.value, !!consent.output.sensitive),
            destination: describeTarget(consent.output.target)
          },
          actions
        });
        return;
      }
      if (index > 0) actions.push({ label: "Back", kind: "ghost", onClick: () => go(index - 1) });
      const branches = current.branches ?? [];
      if (branches.length) {
        for (const branch of branches) {
          actions.push({
            label: branch.label,
            kind: "primary",
            onClick: () => {
              const target = guide?.steps.findIndex((step2) => step2.id === branch.goto) ?? -1;
              void mark("done");
              if (target >= 0) go(target);
              else finish();
            }
          });
        }
      } else {
        actions.push({
          label: index + 1 === guide.steps.length ? "Done" : "Next",
          kind: "primary",
          onClick: () => {
            void mark("done");
            if (guide && index + 1 >= guide.steps.length) finish();
            else go(index + 1);
          }
        });
      }
      if (!resolution) actions.push({ label: "Can't find it", kind: "ghost", onClick: () => void repair(true) });
      if (mode === "check") actions.push({ label: "Re-shoot", kind: "ghost", onClick: () => void reshoot() });
      actions.push({ label: "Ask", kind: "ghost", onClick: () => {
        askQuestion = askQuestion || "";
        draw();
      } });
      actions.push({ label: "Stop", kind: "danger", onClick: () => finish() });
      overlay.render({
        stepNumber: index + 1,
        stepTotal: guide.steps.length,
        title: current.title,
        body: current.body,
        why: current.why,
        notice,
        resolvedVia: resolution?.via,
        ask: {
          question: askQuestion,
          answer: askAnswer || void 0,
          busy: askBusy,
          onSubmit: (q) => void askGuide(q)
        },
        actions
      });
    }
    async function askGuide(question) {
      if (!guide || askBusy) return;
      askQuestion = question;
      askBusy = true;
      askAnswer = "";
      draw();
      const reply = await ask({ type: "replay:ask", guideId: guide.id, question });
      askBusy = false;
      askAnswer = reply?.ok && reply.answer ? reply.answer : reply?.error || "This guide does not say.";
      draw();
    }
    async function go(next) {
      if (!guide) return;
      index = Math.max(0, Math.min(next, guide.steps.length - 1));
      notice = void 0;
      consent = null;
      tracker.reset();
      await locate();
    }
    async function locate() {
      const current = step();
      if (!current) return;
      resolution = await resolveStep(current, void 0);
      if (!resolution) {
        notice = notice ?? { text: "I can\u2019t find that on this page. The description and picture still apply.", tone: "warn" };
      }
      reportHealth(current, false);
      overlay.anchor(resolution?.element ?? null);
      draw();
    }
    async function repair(explicit) {
      const current = step();
      if (!guide || !current || repairing) return;
      repairing = true;
      if (explicit) {
        notice = { text: "Looking for it\u2026", tone: "info" };
        draw();
      }
      resolution = await resolveStep(current, async (snapshot, intent) => {
        const response = await ask({
          type: "replay:repair",
          guideId: guide.id,
          stepId: current.id,
          snapshot,
          intent
        });
        return response?.selector ?? null;
      });
      repairing = false;
      notice = resolution ? { text: "Found it \u2014 the arrow is pointing at it now.", tone: "info" } : { text: "Still can\u2019t find it. Follow the description below.", tone: "warn" };
      if (current) reportHealth(current, true);
      overlay.anchor(resolution?.element ?? null);
      draw();
    }
    async function reshoot() {
      const current = step();
      if (!guide || !current || mode !== "check") return;
      notice = { text: "Capturing a fresh screenshot\u2026", tone: "info" };
      draw();
      const result = await ask({
        type: "check:reshoot",
        guideId: guide.id,
        stepId: current.id,
        crop: reshootCrop(resolution?.element ?? null),
        viewportWidth: window.innerWidth
      });
      notice = result?.ok ? { text: "Sent to your library for review. It replaces the old screenshot only after you approve it there.", tone: "info" } : { text: `Couldn\u2019t re-shoot: ${result?.error ?? "no response from 1ShowcaseTool"}.`, tone: "warn" };
      draw();
    }
    async function mark(state) {
      const current = step();
      if (!guide || !current) return;
      await ask({ type: "replay:progress", guideId: guide.id, stepId: current.id, state });
    }
    function finish() {
      void ask({ type: "replay:finished" });
      teardown();
    }
    function offerHarvest() {
      const current = step();
      if (!current?.outputs?.length || consent) return;
      for (const output of current.outputs) {
        if (harvestDone.has(output.target)) continue;
        const candidate = readOutput(output);
        if (!candidate) continue;
        consent = candidate;
        draw();
        return;
      }
    }
    async function confirmHarvest() {
      if (!consent) return;
      const pending = consent;
      const result = await deliverOnce(
        pending,
        (target, value, sensitive) => ask({ type: "replay:harvest", target, value, sensitive }).then(
          (r) => r ?? { ok: false, error: "no response from 1ShowcaseTool" }
        )
      );
      consent = null;
      if (result.ok) {
        harvestDone.add(pending.output.target);
        notice = { text: `Sent to ${result.destination ?? describeTarget(pending.output.target)}.`, tone: "info" };
        await mark("done");
        if (step()?.branches?.length) draw();
        else if (guide && index + 1 < guide.steps.length) await go(index + 1);
        else draw();
      } else {
        notice = { text: `Couldn\u2019t send it: ${result.error ?? "unknown error"}. Copy the value across by hand.`, tone: "warn" };
        draw();
      }
    }
    function declineHarvest() {
      if (consent) {
        consent.value = "";
        harvestDone.add(consent.output.target);
      }
      consent = null;
      notice = { text: "Left it alone \u2014 copy the value across yourself.", tone: "info" };
      draw();
    }
    function onInteraction(event) {
      const current = step();
      if (!guide || !current || consent) return;
      if (overlay.ownsEvent(event)) return;
      const verdict = tracker.classify(event, current, resolution?.element ?? null);
      if (verdict === "on-path") {
        notice = void 0;
        window.setTimeout(() => void afterAction(), 500);
        return;
      }
      if (verdict === "off-path") {
        if (tracker.shouldEscalate()) {
          notice = { text: "That isn\u2019t the step. Here\u2019s why it matters \u2014 expand \u201CWhy this step exists\u201D, or ask me to find it again.", tone: "warn" };
          void repair(false);
        } else {
          notice = { text: "Not that one \u2014 here.", tone: "warn" };
          void locate();
        }
        draw();
      }
    }
    async function afterAction() {
      const current = step();
      if (!guide || !current) return;
      if (current.outputs?.length) {
        offerHarvest();
        if (consent) return;
      }
      if (verifyPasses(current)) {
        if (current.branches?.length) {
          await mark("done");
          draw();
          return;
        }
        await mark("done");
        if (index + 1 >= guide.steps.length) finish();
        else await go(index + 1);
        return;
      }
      await locate();
    }
    function tick() {
      const current = step();
      if (!guide || !current || consent) return;
      const urlVerdict = tracker.classifyUrl(
        current,
        location.href,
        guide.steps.map((s) => s.urlPattern).filter(Boolean)
      );
      if (urlVerdict === "wrong-page") {
        notice = { text: "This isn\u2019t the page for this step.", tone: "block" };
        overlay.render({
          stepNumber: index + 1,
          stepTotal: guide.steps.length,
          title: current.title,
          body: current.body,
          why: current.why,
          notice,
          actions: [
            {
              label: "Take me back",
              kind: "primary",
              onClick: () => {
                location.href = current.urlPattern.replace(/:[a-z]+/gi, "");
              }
            },
            { label: "Stay here", kind: "ghost", onClick: () => {
              notice = void 0;
              draw();
            } },
            { label: "Stop", kind: "danger", onClick: () => finish() }
          ]
        });
        return;
      }
      if (verifyPasses(current)) {
        void afterAction();
        return;
      }
      if (current.outputs?.length) offerHarvest();
      if (resolution && !resolution.element.isConnected) void locate();
      if (tracker.isStuck() && !repairing) {
        tracker.markActivity();
        notice = { text: "Stuck? Expand \u201CWhy this step exists\u201D, or I can look for the target again.", tone: "info" };
        draw();
      }
    }
    function attach() {
      document.addEventListener("click", onInteraction, true);
      document.addEventListener("submit", onInteraction, true);
      document.addEventListener("change", onInteraction, true);
      tickTimer = window.setInterval(tick, 1200);
    }
    function teardown() {
      document.removeEventListener("click", onInteraction, true);
      document.removeEventListener("submit", onInteraction, true);
      document.removeEventListener("change", onInteraction, true);
      if (tickTimer !== null) window.clearInterval(tickTimer);
      tickTimer = null;
      if (consent) consent.value = "";
      consent = null;
      guide = null;
      resolution = null;
      overlay.unmount();
      scope[GUARD] = false;
    }
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "replay:load") {
        guide = message.guide;
        mode = message.mode ?? "follow";
        index = Math.max(0, Math.min(message.startIndex, guide.steps.length - 1));
        harvestDone = /* @__PURE__ */ new Set();
        overlay.mount();
        attach();
        void go(index).then(() => {
          if (mode === "check" && !notice) {
            notice = { text: "Checking this guide \u2014 walk it as a reader would. The results land in your library when you finish.", tone: "info" };
            draw();
          }
        });
        return;
      }
      if (message?.type === "replay:stop") teardown();
    });
    void ask({ type: "replay:ready" });
    window.addEventListener("beforeunload", () => {
      if (consent) consent.value = "";
    });
  }
  main();
})();
