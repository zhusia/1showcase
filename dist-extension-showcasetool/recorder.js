(() => {
  // extension-showcasetool/src/recorder/selectors.ts
  var TESTID_ATTRS = ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy"];
  var GENERATED_TOKEN_RE = /(^|[-_:])(?:[0-9]{4,}|[a-f0-9]{8,}|[a-z]{1,3}[0-9]{4,})($|[-_:])|^(?:mui|css|sc|jss|emotion|ng|ember|svelte)[-_]?[a-z0-9]{4,}$/i;
  function isStableToken(value) {
    if (!value || value.length > 120) return false;
    return !GENERATED_TOKEN_RE.test(value);
  }
  function cssEscape(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
    return value.replace(/([^\w-])/g, "\\$1");
  }
  function resolvesUniquely(root, selector, target) {
    try {
      const matches = root.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === target;
    } catch {
      return false;
    }
  }
  function accessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria?.trim()) return aria.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim() ?? "").filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const labels = el.labels;
      if (labels?.length) {
        const text2 = Array.from(labels).map((l) => l.textContent?.trim() ?? "").filter(Boolean).join(" ");
        if (text2) return text2;
      }
      const placeholder = el.getAttribute("placeholder");
      if (placeholder?.trim()) return placeholder.trim();
    }
    const title = el.getAttribute("title");
    if (title?.trim()) return title.trim();
    const text = directText(el);
    return text.length <= 80 ? text : "";
  }
  function directText(el) {
    return (el.textContent ?? "").replace(/\s+/g, " ").trim();
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
  var LANDMARK_SELECTOR = "main,nav,header,footer,aside,form,[role=main],[role=navigation],[role=banner],[role=contentinfo],[role=dialog],[role=form]";
  function nearestLandmark(el) {
    const landmark = el.closest(LANDMARK_SELECTOR);
    if (!landmark) return void 0;
    const name = accessibleName(landmark);
    const role = roleOf(landmark);
    return name ? `${role}:${name}` : role;
  }
  function a11yAnchorFor(el) {
    const anchor = { role: roleOf(el) };
    const name = accessibleName(el);
    if (name) anchor.name = name;
    const landmark = nearestLandmark(el);
    if (landmark) anchor.landmark = landmark;
    return anchor;
  }
  function cssPath(el) {
    const doc = el.ownerDocument;
    const parts = [];
    let current = el;
    let depth = 0;
    while (current && current !== doc.documentElement && depth < 8) {
      let part = current.tagName.toLowerCase();
      const id = current.getAttribute("id");
      if (id && isStableToken(id)) {
        parts.unshift(`#${cssEscape(id)}`);
        break;
      }
      const stableClass = Array.from(current.classList).find(isStableToken);
      if (stableClass) part += `.${cssEscape(stableClass)}`;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
      depth += 1;
    }
    const selector = parts.join(" > ");
    return selector && resolvesUniquely(doc, selector, el) ? selector : null;
  }
  function buildSelectors(el) {
    const doc = el.ownerDocument;
    const candidates = [];
    const seen = /* @__PURE__ */ new Set();
    const push = (strategy, value) => {
      if (!value || seen.has(value)) return;
      seen.add(value);
      candidates.push({ strategy, value });
    };
    for (const attr of TESTID_ATTRS) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const selector = `[${attr}="${cssEscape(value)}"]`;
      if (resolvesUniquely(doc, selector, el)) push("testid", selector);
    }
    const id = el.getAttribute("id");
    if (id && isStableToken(id)) {
      const selector = `#${cssEscape(id)}`;
      if (resolvesUniquely(doc, selector, el)) push("id", selector);
    }
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel?.trim()) {
      const selector = `${el.tagName.toLowerCase()}[aria-label="${cssEscape(ariaLabel.trim())}"]`;
      if (resolvesUniquely(doc, selector, el)) push("aria-label", selector);
    }
    const role = roleOf(el);
    const name = accessibleName(el);
    if (role && name && name.length <= 80) push("role-name", `role=${role}[name="${name}"]`);
    if (name && name.length <= 60 && /[a-z]/i.test(name)) push("text", `text=${name}`);
    const path = cssPath(el);
    if (path) push("css-path", path);
    return candidates;
  }
  function normalizeUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const segments = url.pathname.split("/").map((segment) => {
        if (!segment) return segment;
        if (/^[0-9]+$/.test(segment)) return ":id";
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ":uuid";
        if (/^[0-9a-f]{24,}$/i.test(segment)) return ":hash";
        if (/^[A-Za-z0-9_-]{18,}$/.test(segment) && /[0-9]/.test(segment)) return ":token";
        return segment;
      });
      return `${url.origin}${segments.join("/")}`;
    } catch {
      return rawUrl;
    }
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
  var ENTROPY_MIN_LENGTH = 24;
  var ENTROPY_THRESHOLD_BITS = 3.4;
  function shannonEntropy(value) {
    if (!value.length) return 0;
    const counts = /* @__PURE__ */ new Map();
    for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let bits = 0;
    for (const count of counts.values()) {
      const p = count / value.length;
      bits -= p * Math.log2(p);
    }
    return bits;
  }
  function looksHighEntropy(value) {
    const trimmed = value.trim();
    if (trimmed.length < ENTROPY_MIN_LENGTH) return false;
    if (/\s/.test(trimmed)) return false;
    if (!/[A-Za-z]/.test(trimmed) || !/[0-9]/.test(trimmed)) return false;
    return shannonEntropy(trimmed) >= ENTROPY_THRESHOLD_BITS;
  }
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
  function sampleOf(text) {
    const trimmed = text.trim();
    if (trimmed.length <= 8) return "\u2022".repeat(trimmed.length);
    return `${trimmed.slice(0, 4)}${"\u2022".repeat(Math.min(8, trimmed.length - 8))}${trimmed.slice(-4)}`;
  }

  // extension-showcasetool/src/recorder/redact.ts
  var customRules = [];
  function setCustomRules(rules) {
    customRules = Array.isArray(rules) ? rules.slice(0, 80) : [];
  }
  function applyCustom(raw) {
    let next = raw;
    let placeholder;
    for (const rule of customRules) {
      if (rule.kind === "literal") {
        if (next.includes(rule.pattern)) {
          next = next.split(rule.pattern).join(rule.placeholder);
          placeholder = rule.placeholder;
        }
      } else {
        try {
          const re = new RegExp(rule.pattern, "g");
          if (re.test(next)) {
            next = next.replace(new RegExp(rule.pattern, "g"), rule.placeholder);
            placeholder = rule.placeholder;
          }
        } catch {
        }
      }
    }
    return { value: next, placeholder, hit: next !== raw };
  }
  function redactFieldValue(el, rawValue) {
    const warnings = [];
    const input = el;
    const type = (input.type ?? "").toLowerCase();
    const autocomplete = el.getAttribute("autocomplete") ?? "";
    const nameParts = [el.getAttribute("name"), el.getAttribute("id"), el.getAttribute("aria-label"), el.getAttribute("placeholder")];
    if (NEVER_STORE_INPUT_TYPES.includes(type)) {
      return { masked: true, placeholder: "<YOUR_PASSWORD>", warnings };
    }
    if (NEVER_STORE_AUTOCOMPLETE_RE.test(autocomplete)) {
      return { masked: true, placeholder: autocomplete.startsWith("cc-") ? "<YOUR_CARD_DETAILS>" : "<YOUR_ONE_TIME_CODE>", warnings };
    }
    if (isSensitiveFieldName(...nameParts)) {
      return { masked: true, placeholder: placeholderFor(nameParts), warnings };
    }
    if (!rawValue) return { value: "", masked: false, warnings };
    const custom = applyCustom(rawValue);
    if (custom.hit) {
      return { masked: true, placeholder: custom.placeholder ?? "<REDACTED>", warnings };
    }
    const hits = detectSecrets(rawValue);
    if (hits.length) {
      return {
        masked: true,
        placeholder: `<REDACTED:${hits[0].label.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}>`,
        warnings: hits.map((hit) => ({ rule: hit.rule, label: hit.label, where: "value", sample: sampleOf(hit.text) }))
      };
    }
    if (looksHighEntropy(rawValue)) {
      warnings.push({
        rule: "auto:high-entropy",
        label: "High-entropy value \u2014 check whether this is a secret",
        where: "value",
        sample: sampleOf(rawValue)
      });
    }
    return { value: rawValue, masked: false, warnings };
  }
  function placeholderFor(nameParts) {
    const source = nameParts.find((p) => p && p.trim()) ?? "value";
    const slug = source.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase().slice(0, 32);
    return `<YOUR_${slug || "VALUE"}>`;
  }
  function findSecretRegions() {
    const rects = [];
    const warnings = [];
    const seen = /* @__PURE__ */ new Set();
    for (const field of Array.from(document.querySelectorAll("input"))) {
      const type = (field.type ?? "").toLowerCase();
      const autocomplete = field.getAttribute("autocomplete") ?? "";
      const sensitive = NEVER_STORE_INPUT_TYPES.includes(type) || NEVER_STORE_AUTOCOMPLETE_RE.test(autocomplete) || !!field.value && isSensitiveFieldName(field.getAttribute("name"), field.getAttribute("id"), field.getAttribute("aria-label"));
      if (!sensitive) continue;
      const rect = visibleRect(field);
      if (rect) rects.push(rect);
    }
    for (const rule of customRules) {
      if (rule.kind !== "literal" || rule.pattern.length < 3) continue;
      const walkerCustom = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
      let customNode = walkerCustom.nextNode();
      while (customNode) {
        const text = customNode.nodeValue ?? "";
        let from = 0;
        while (from < text.length) {
          const at = text.indexOf(rule.pattern, from);
          if (at < 0) break;
          const rect = rectForTextRange(customNode, at, at + rule.pattern.length);
          if (rect) {
            const key = `${Math.round(rect.x)}:${Math.round(rect.y)}`;
            if (!seen.has(key)) {
              seen.add(key);
              rects.push(rect);
              warnings.push({ rule: "custom:vocab", label: rule.placeholder, where: "page-text", sample: sampleOf(rule.pattern) });
            }
          }
          from = at + rule.pattern.length;
        }
        customNode = walkerCustom.nextNode();
      }
    }
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const text = node.nodeValue ?? "";
      if (text.trim().length >= 12) {
        for (const hit of detectSecrets(text)) {
          const rect = rectForTextRange(node, hit.start, hit.end);
          if (rect) {
            rects.push(rect);
            const key = `${hit.rule}:${hit.text.slice(0, 12)}`;
            if (!seen.has(key)) {
              seen.add(key);
              warnings.push({ rule: hit.rule, label: `${hit.label} visible on screen`, where: "page-text", sample: sampleOf(hit.text) });
            }
          }
        }
      }
      node = walker.nextNode();
    }
    return { rects, warnings };
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

  // extension-showcasetool/src/recorder/index.ts
  var INTERACTIVE = "a,button,input,select,textarea,summary,label,[role],[onclick],[tabindex]";
  var NAV_KEYS = /* @__PURE__ */ new Set(["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);
  var GUARD = "__oneshowcasetoolRecorder";
  function main() {
    const scope = globalThis;
    if (scope[GUARD]) return;
    scope[GUARD] = true;
    let stopped = false;
    let lastUrl = location.href;
    const pendingInputs = /* @__PURE__ */ new Map();
    const send = (message) => {
      if (stopped) return;
      try {
        chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
      } catch {
      }
    };
    function baseStep(kind, el) {
      return {
        id: crypto.randomUUID(),
        kind,
        url: location.href,
        urlPattern: normalizeUrl(location.href),
        pageTitle: document.title,
        selectors: el ? buildSelectors(el) : [],
        a11y: el ? a11yAnchorFor(el) : {},
        valueMasked: false,
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
        warnings: [],
        capturedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    function cropFor(el) {
      const { rects, warnings } = findSecretRegions();
      if (!el) return { warnings };
      const box = el.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return { warnings };
      const pad = 120;
      const crop = {
        x: Math.max(0, box.left - pad),
        y: Math.max(0, box.top - pad),
        width: Math.min(window.innerWidth, box.width + pad * 2),
        height: Math.min(window.innerHeight, box.height + pad * 2),
        fills: rects,
        // Carried alongside the crop so the worker can say where the target ended up inside
        // the cropped image. Near the centre usually, but not when the crop clamps at an edge.
        target: { x: box.left, y: box.top, width: box.width, height: box.height }
      };
      return { crop, warnings };
    }
    function capture(kind, el, extra) {
      const step = { ...baseStep(kind, el), ...extra };
      const { crop, warnings } = cropFor(el);
      step.warnings = [...step.warnings ?? [], ...warnings];
      send({ type: "recorder:step", step, crop, wantsFullPage: kind === "navigate" });
    }
    const onClick = (event) => {
      const target = event.target;
      if (!target || !(target instanceof Element)) return;
      const el = target.closest(INTERACTIVE) ?? target;
      capture("click", el);
    };
    const onInput = (event) => {
      const el = event.target;
      if (!el || !(el instanceof Element)) return;
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
      const existing = pendingInputs.get(el);
      if (existing) clearTimeout(existing);
      pendingInputs.set(
        el,
        setTimeout(() => {
          pendingInputs.delete(el);
          const redaction = redactFieldValue(el, el.value);
          capture("input", el, {
            value: redaction.value,
            valueMasked: redaction.masked,
            placeholder: redaction.placeholder,
            warnings: redaction.warnings
          });
        }, 600)
      );
    };
    const onChange = (event) => {
      const el = event.target;
      if (el instanceof HTMLSelectElement) {
        const redaction = redactFieldValue(el, el.options[el.selectedIndex]?.text ?? "");
        capture("select", el, { value: redaction.value, valueMasked: redaction.masked, placeholder: redaction.placeholder });
      }
    };
    const onKeyDown = (event) => {
      if (!NAV_KEYS.has(event.key)) return;
      const el = event.target instanceof Element ? event.target : null;
      capture("keydown", el, { value: event.key });
    };
    const onMaybeNavigate = () => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      setTimeout(() => capture("navigate", null), 400);
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("change", onChange, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("popstate", onMaybeNavigate);
    window.addEventListener("hashchange", onMaybeNavigate);
    const urlPoll = setInterval(onMaybeNavigate, 700);
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "recorder:rules") {
        setCustomRules(message.rules ?? []);
        return;
      }
      if (message?.type !== "recorder:stop") return;
      stopped = true;
      for (const timer of pendingInputs.values()) clearTimeout(timer);
      pendingInputs.clear();
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("change", onChange, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("popstate", onMaybeNavigate);
      window.removeEventListener("hashchange", onMaybeNavigate);
      clearInterval(urlPoll);
      scope[GUARD] = false;
    });
    capture("navigate", null);
    send({ type: "recorder:ready" });
  }
  main();
})();
