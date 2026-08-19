(() => {
  // extension-showcasetool/src/shared/relay.ts
  var RELAY_HOST = "127.0.0.1";
  var RELAY_PORTS = [47821, 47822, 47823, 47824, 47825];
  var TOKEN_HEADER = "x-oneshowcasetool-token";
  var STORE_KEY = "relay";
  async function readStore() {
    const stored = await chrome.storage.local.get(STORE_KEY);
    const value = stored[STORE_KEY];
    return value && typeof value.token === "string" && typeof value.port === "number" ? value : null;
  }
  async function writeStore(value) {
    if (value) await chrome.storage.local.set({ [STORE_KEY]: value });
    else await chrome.storage.local.remove(STORE_KEY);
  }
  function base(port) {
    return `http://${RELAY_HOST}:${port}`;
  }
  async function discover() {
    const stored = await readStore();
    const order = stored ? [stored.port, ...RELAY_PORTS.filter((p) => p !== stored.port)] : RELAY_PORTS;
    for (const port of order) {
      try {
        const res = await fetch(`${base(port)}/health`, { method: "GET" });
        if (!res.ok) continue;
        const data = await res.json();
        if (data.app === "oneshowcasetool") return port;
      } catch {
      }
    }
    return null;
  }
  async function isPaired() {
    return await readStore() !== null;
  }
  async function pair() {
    const port = await discover();
    if (port === null) return { ok: false, error: "1ShowcaseTool is not running" };
    try {
      const res = await fetch(`${base(port)}/pair?origin=${encodeURIComponent(location.origin)}`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error ?? `pairing failed (${res.status})` };
      }
      const data = await res.json();
      if (!data.token) return { ok: false, error: "app did not return a token" };
      await writeStore({ port, token: data.token });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  async function call(path, body) {
    const stored = await readStore();
    if (!stored) return { ok: false, error: "not paired with 1ShowcaseTool", needsPairing: true };
    const attempt = async (port) => {
      const res = await fetch(`${base(port)}${path}`, {
        method: body === void 0 ? "GET" : "POST",
        headers: body === void 0 ? { [TOKEN_HEADER]: stored.token } : { "content-type": "application/json", [TOKEN_HEADER]: stored.token },
        body: body === void 0 ? void 0 : JSON.stringify(body)
      });
      if (res.status === 401) {
        await writeStore(null);
        return { ok: false, error: "pairing expired \u2014 reconnect to 1ShowcaseTool", needsPairing: true };
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { ok: false, error: err.error ?? `relay returned ${res.status}` };
      }
      return { ok: true, data: await res.json() };
    };
    try {
      return await attempt(stored.port);
    } catch {
      const port = await discover();
      if (port === null) return { ok: false, error: "1ShowcaseTool is not running" };
      await writeStore({ ...stored, port });
      try {
        return await attempt(port);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
  }

  // extension-showcasetool/src/sw/screenshots.ts
  var CAPTURE_MIN_INTERVAL_MS = 600;
  var captureChain = Promise.resolve();
  var lastCaptureAt = 0;
  var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function queueCapture(task) {
    const run = captureChain.then(async () => {
      const wait = CAPTURE_MIN_INTERVAL_MS - (Date.now() - lastCaptureAt);
      if (wait > 0) await sleep(wait);
      try {
        return await task();
      } finally {
        lastCaptureAt = Date.now();
      }
    });
    captureChain = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  function explainCaptureError(message) {
    if (/all_urls|activeTab/i.test(message)) {
      return "Chrome has not granted screenshot access for this tab. Open the 1ShowcaseTool popup on this page once, then carry on \u2014 the remaining steps will have screenshots.";
    }
    if (/quota/i.test(message)) return "Chrome rate-limited screenshot capture for this step.";
    if (/cannot access|extension manifest|chrome:\/\//i.test(message)) return "Chrome does not allow screenshots of this page.";
    return `Screenshot capture failed: ${message}`;
  }
  async function captureTab(windowId) {
    return queueCapture(async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const dataUri = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
          if (typeof dataUri === "string" && dataUri.startsWith("data:image/")) return { ok: true, dataUri };
          return { ok: false, error: "Chrome returned an empty screenshot." };
        } catch (err) {
          const message = err?.message ?? String(err);
          if (/quota/i.test(message) && attempt === 0) {
            await sleep(CAPTURE_MIN_INTERVAL_MS);
            continue;
          }
          return { ok: false, error: explainCaptureError(message) };
        }
      }
      return { ok: false, error: "Screenshot capture failed after a retry." };
    });
  }
  async function cropAndRedact(dataUri, crop, viewportWidth) {
    let bitmap = null;
    try {
      const response = await fetch(dataUri);
      const blob = await response.blob();
      bitmap = await createImageBitmap(blob);
      const scale = viewportWidth > 0 ? bitmap.width / viewportWidth : 1;
      const px = (value) => Math.round(value * scale);
      const region = crop ? {
        x: clamp(px(crop.x), 0, bitmap.width),
        y: clamp(px(crop.y), 0, bitmap.height),
        width: clamp(px(crop.width), 1, bitmap.width),
        height: clamp(px(crop.height), 1, bitmap.height)
      } : { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
      region.width = Math.min(region.width, bitmap.width - region.x);
      region.height = Math.min(region.height, bitmap.height - region.y);
      if (region.width <= 0 || region.height <= 0) {
        return { ok: false, error: "The captured region was empty \u2014 the target may have been off screen." };
      }
      const canvas = new OffscreenCanvas(region.width, region.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return { ok: false, error: "Could not open a drawing context to redact the screenshot." };
      }
      ctx.drawImage(bitmap, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
      ctx.fillStyle = "#0b0e14";
      for (const fill of crop?.fills ?? []) {
        const x = px(fill.x) - region.x;
        const y = px(fill.y) - region.y;
        const w = px(fill.width);
        const h = px(fill.height);
        if (x + w < 0 || y + h < 0 || x > region.width || y > region.height) continue;
        ctx.fillRect(x, y, w, h);
      }
      const out = await canvas.convertToBlob({ type: "image/png" });
      return { ok: true, dataUri: await blobToDataUri(out), targetRect: normalizeTarget(crop, region, px) };
    } catch (err) {
      return { ok: false, error: `Could not redact the screenshot, so it was discarded: ${err?.message ?? String(err)}` };
    } finally {
      bitmap?.close();
    }
  }
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
  function normalizeTarget(crop, region, px) {
    if (!crop?.target || region.width <= 0 || region.height <= 0) return void 0;
    const x = (px(crop.target.x) - region.x) / region.width;
    const y = (px(crop.target.y) - region.y) / region.height;
    const width = px(crop.target.width) / region.width;
    const height = px(crop.target.height) / region.height;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return void 0;
    if (width <= 0 || height <= 0) return void 0;
    if (x + width <= 0 || y + height <= 0 || x >= 1 || y >= 1) return void 0;
    return {
      x: clamp(x, 0, 1),
      y: clamp(y, 0, 1),
      width: clamp(width, 5e-3, 1),
      height: clamp(height, 5e-3, 1)
    };
  }
  function blobToDataUri(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("could not encode screenshot"));
      reader.readAsDataURL(blob);
    });
  }

  // extension-showcasetool/src/sw/eligibility.ts
  var BUNDLED_HOSTS = [
    "console.cloud.google.com",
    "search.google.com",
    "developers.facebook.com",
    "developer.x.com",
    "www.linkedin.com",
    "www.reddit.com",
    "developers.pinterest.com",
    "app.dataforseo.com",
    "hashnode.com",
    "dev.to"
  ];
  var INELIGIBLE_SCHEMES = ["chrome:", "chrome-extension:", "edge:", "about:", "devtools:", "view-source:", "file:"];
  var INELIGIBLE_HOSTS = ["chromewebstore.google.com", "chrome.google.com"];
  var LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
  function ineligibleReason(rawUrl) {
    if (!rawUrl) return "No active tab.";
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return "This tab has no normal web address.";
    }
    if (INELIGIBLE_SCHEMES.includes(url.protocol)) {
      return `Chrome does not allow extensions to run on ${url.protocol.replace(":", "")} pages.`;
    }
    if (INELIGIBLE_HOSTS.includes(url.hostname)) {
      return "Chrome does not allow extensions to run on the Chrome Web Store.";
    }
    if (url.protocol !== "https:" && !LOCAL_HOSTS.includes(url.hostname)) {
      return "Only https pages (or localhost) can be recorded.";
    }
    return null;
  }
  function originPattern(rawUrl) {
    if (!rawUrl) return null;
    try {
      return `${new URL(rawUrl).origin}/*`;
    } catch {
      return null;
    }
  }
  function hostnameOf(rawUrl) {
    if (!rawUrl) return null;
    try {
      return new URL(rawUrl).hostname;
    } catch {
      return null;
    }
  }
  function isBundledHost(rawUrl) {
    const hostname = hostnameOf(rawUrl);
    return hostname !== null && BUNDLED_HOSTS.includes(hostname);
  }
  function isInternalOrigin(origin) {
    if (origin.startsWith("http://127.0.0.1")) return true;
    try {
      return BUNDLED_HOSTS.includes(new URL(origin.replace(/\*$/, "")).hostname);
    } catch {
      return false;
    }
  }

  // extension-showcasetool/src/sw/index.ts
  var RECORDING_KEY = "recording";
  var REPLAY_KEY = "replay";
  async function canRecord(rawUrl) {
    if (!rawUrl || ineligibleReason(rawUrl)) return false;
    if (isBundledHost(rawUrl)) return true;
    const pattern = originPattern(rawUrl);
    if (!pattern) return false;
    try {
      return await chrome.permissions.contains({ origins: [pattern] });
    } catch {
      return false;
    }
  }
  async function grantedSites() {
    const all = await chrome.permissions.getAll();
    return (all.origins ?? []).filter((origin) => !isInternalOrigin(origin)).sort();
  }
  async function getRecording() {
    const stored = await chrome.storage.session.get(RECORDING_KEY);
    return stored[RECORDING_KEY] ?? null;
  }
  async function setRecording(state) {
    if (state) await chrome.storage.session.set({ [RECORDING_KEY]: state });
    else await chrome.storage.session.remove(RECORDING_KEY);
  }
  async function getReplay() {
    const stored = await chrome.storage.session.get(REPLAY_KEY);
    return stored[REPLAY_KEY] ?? null;
  }
  async function setReplay(state) {
    if (state) await chrome.storage.session.set({ [REPLAY_KEY]: state });
    else await chrome.storage.session.remove(REPLAY_KEY);
  }
  var BADGE_REC = "#e8453f";
  var BADGE_GO = "#22b8d6";
  var BADGE_IDLE = "#000000";
  var BADGE_INK = "#0b0e14";
  function setBadge(text, color) {
    void chrome.action.setBadgeText({ text });
    void chrome.action.setBadgeBackgroundColor({ color });
    void chrome.action.setBadgeTextColor({ color: BADGE_INK });
  }
  async function startRecording(title) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return { ok: false, error: "no active tab" };
    const blocked = ineligibleReason(tab.url);
    if (blocked) return { ok: false, error: blocked };
    if (!await canRecord(tab.url)) {
      return { ok: false, error: "this extension has not been given access to this site yet" };
    }
    if (await getReplay()) return { ok: false, error: "stop the running guide before recording" };
    const created = await call("/session/start", { title });
    if (!created.ok) return { ok: false, error: created.error };
    await setRecording({ sessionId: created.data.sessionId, tabId: tab.id, seq: 0, startedAt: (/* @__PURE__ */ new Date()).toISOString(), lastUrl: tab.url });
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["recorder.js"] });
      if (created.data.rules?.length) {
        await chrome.tabs.sendMessage(tab.id, { type: "recorder:rules", rules: created.data.rules }).catch(() => void 0);
      }
    } catch (err) {
      await setRecording(null);
      return { ok: false, error: `could not attach the recorder: ${err.message}` };
    }
    setBadge("REC", BADGE_REC);
    return { ok: true };
  }
  async function stopRecording() {
    const state = await getRecording();
    if (!state) return { ok: false, error: "not recording" };
    try {
      await chrome.tabs.sendMessage(state.tabId, { type: "recorder:stop" });
    } catch {
    }
    await setRecording(null);
    setBadge("", BADGE_IDLE);
    const stopped = await call("/session/stop", { sessionId: state.sessionId });
    return stopped.ok ? { ok: true } : { ok: false, error: stopped.error };
  }
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    void (async () => {
      if (changeInfo.status !== "complete") return;
      const recording = await getRecording();
      if (recording?.tabId === tabId) {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ["recorder.js"] });
        } catch {
        }
        return;
      }
      const replaying = await getReplay();
      if (replaying?.tabId === tabId) void resumeReplay(tabId, replaying);
    })();
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      const recording = await getRecording();
      if (recording?.tabId === tabId) {
        await setRecording(null);
        setBadge("", BADGE_IDLE);
        await call("/session/stop", { sessionId: recording.sessionId });
      }
      const replaying = await getReplay();
      if (replaying?.tabId === tabId) {
        await setReplay(null);
        setBadge("", BADGE_IDLE);
      }
    })();
  });
  async function startReplay(guideId, mode = "follow") {
    if (await getRecording()) return { ok: false, error: "stop recording before running a guide" };
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false, error: "no active tab" };
    const loaded = await call(`/guide?id=${encodeURIComponent(guideId)}`);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    const { guide, progress } = loaded.data;
    const startIndex = mode === "check" ? 0 : firstUnfinished(guide, progress);
    await setReplay({ guideId, tabId: tab.id, stepIndex: startIndex, mode });
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["replay.js"] });
      await chrome.tabs.sendMessage(tab.id, { type: "replay:load", guide, startIndex, progress, mode });
    } catch (err) {
      await setReplay(null);
      return { ok: false, error: `could not attach the overlay: ${err.message}` };
    }
    setBadge(mode === "check" ? "CHK" : "GO", BADGE_GO);
    return { ok: true };
  }
  async function resumeReplay(tabId, state) {
    const loaded = await call(`/guide?id=${encodeURIComponent(state.guideId)}`);
    if (!loaded.ok) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["replay.js"] });
      await chrome.tabs.sendMessage(tabId, {
        type: "replay:load",
        guide: loaded.data.guide,
        startIndex: firstUnfinished(loaded.data.guide, loaded.data.progress),
        progress: loaded.data.progress,
        mode: state.mode ?? "follow"
      });
    } catch {
    }
  }
  async function stopReplay() {
    const state = await getReplay();
    if (state) {
      if (state.mode === "check" && state.health && Object.keys(state.health).length) {
        await call("/guide/health", {
          guideId: state.guideId,
          steps: Object.entries(state.health).map(([stepId, health]) => ({ stepId, ...health }))
        });
      }
      try {
        await chrome.tabs.sendMessage(state.tabId, { type: "replay:stop" });
      } catch {
      }
    }
    await setReplay(null);
    setBadge("", BADGE_IDLE);
    return { ok: true };
  }
  function firstUnfinished(guide, progress) {
    const index = guide.steps.findIndex((step) => progress[step.id] !== "done" && progress[step.id] !== "skipped");
    return index === -1 ? 0 : index;
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void (async () => {
      try {
        const result = await handle(message, sender);
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  });
  async function handle(message, sender) {
    switch (message.type) {
      // ---- recorder
      case "recorder:ready":
        return { ok: true };
      case "recorder:step": {
        const state = await getRecording();
        if (!state || sender.tab?.id !== state.tabId) return { ok: false, error: "not recording this tab" };
        const seq = state.seq + 1;
        await setRecording({ ...state, seq, lastUrl: message.step.url });
        let screenshot;
        let fullPage;
        let captureError;
        let targetRect;
        const viewportWidth = message.step.viewport.width;
        const captured = await captureTab(sender.tab.windowId);
        if (!captured.ok) {
          captureError = captured.error;
        } else {
          const cropped = await cropAndRedact(captured.dataUri, message.crop, viewportWidth);
          if (cropped.ok) {
            screenshot = cropped.dataUri;
            targetRect = cropped.targetRect;
          } else {
            captureError = cropped.error;
          }
          if (message.wantsFullPage) {
            const whole = await cropAndRedact(
              captured.dataUri,
              { x: 0, y: 0, width: viewportWidth, height: message.step.viewport.height, fills: message.crop?.fills ?? [] },
              viewportWidth
            );
            if (whole.ok) fullPage = whole.dataUri;
            else captureError ??= whole.error;
          }
        }
        if (captureError) console.warn(`[showcasetool] step ${seq}: ${captureError}`);
        const sent = await call("/session/step", {
          sessionId: state.sessionId,
          step: { ...message.step, seq, screenshot, fullPage, captureError, targetRect }
        });
        return sent.ok ? { ok: true } : { ok: false, error: sent.error };
      }
      // ---- replay
      case "replay:ready":
        return { ok: true };
      case "replay:finished":
        return stopReplay();
      case "replay:progress": {
        const state = await getReplay();
        if (state) {
          const index = Math.max(state.stepIndex, 0);
          await setReplay({ ...state, stepIndex: index });
        }
        const saved = await call("/progress", message);
        return saved.ok ? { ok: true } : { ok: false, error: saved.error };
      }
      case "replay:repair": {
        const repaired = await call("/repair", message);
        return repaired.ok ? repaired.data : { selector: null, error: repaired.error };
      }
      /**
       * Per-step anchor health from a check run. Accumulated in session state and flushed once
       * at the end, so a multi-page check survives worker restarts. Dropped on the floor in
       * follow mode: a Follower's replay must never report anything about them (§7.6), and the
       * guard lives here rather than trusting the content script to stay quiet.
       */
      case "replay:step-health": {
        const state = await getReplay();
        if (!state || state.mode !== "check" || state.guideId !== message.guideId) return { ok: true };
        await setReplay({ ...state, health: { ...state.health, [message.stepId]: message.health } });
        return { ok: true };
      }
      /**
       * A re-shot step screenshot from a check run. Same capture-and-scrub pipeline the
       * recorder uses — the page computed the fills, the worker destroys those pixels before
       * anything leaves the browser. The app stores the frame as a pending proposal; nothing
       * in any guide changes until the Maker approves it there. Check mode only, enforced
       * here as well as at the button.
       */
      case "check:reshoot": {
        const state = await getReplay();
        if (!state || state.mode !== "check" || sender.tab?.id !== state.tabId || state.guideId !== message.guideId) {
          return { ok: false, error: "not checking this guide" };
        }
        const captured = await captureTab(sender.tab.windowId);
        if (!captured.ok) return { ok: false, error: captured.error };
        const processed = await cropAndRedact(captured.dataUri, message.crop, message.viewportWidth);
        if (!processed.ok) return { ok: false, error: processed.error };
        const stashed = await call("/guide/reshoot", {
          guideId: message.guideId,
          stepId: message.stepId,
          screenshot: processed.dataUri,
          targetRect: processed.targetRect ?? null
        });
        return stashed.ok ? { ok: true } : { ok: false, error: stashed.error };
      }
      case "replay:explain": {
        const explained = await call("/explain", message);
        return explained.ok ? explained.data : { text: "", error: explained.error };
      }
      case "replay:ask": {
        const asked = await call("/guide/ask", { guideId: message.guideId, question: message.question });
        return asked.ok ? { ok: true, answer: asked.data.answer } : { ok: false, error: asked.error };
      }
      /**
       * Value harvest (§7.6). The worker is a pass-through: it forwards to the loopback relay
       * and returns only where the value landed. Nothing is stored — not in
       * chrome.storage.local, not in session, not in a variable that outlives this call.
       */
      case "replay:harvest": {
        const delivered = await call("/harvest", {
          target: message.target,
          value: message.value,
          sensitive: message.sensitive
        });
        return delivered.ok ? { ok: true, destination: delivered.data.destination } : { ok: false, error: delivered.error };
      }
      // ---- popup
      case "popup:status": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const port = await discover();
        const status = {
          paired: await isPaired(),
          appReachable: port !== null,
          recording: await getRecording(),
          replaying: await getReplay(),
          canRecordHere: await canRecord(tab?.url),
          currentOrigin: originPattern(tab?.url),
          currentHostname: hostnameOf(tab?.url),
          ineligibleReason: ineligibleReason(tab?.url)
        };
        return status;
      }
      case "popup:list-sites":
        return { sites: await grantedSites() };
      /**
       * Revoking is the counterpart to granting and belongs in the same place. Unlike
       * requesting, this needs no user gesture, so the worker can do it.
       */
      case "popup:remove-site": {
        const removed = await chrome.permissions.remove({ origins: [message.origin] });
        return { ok: removed };
      }
      case "popup:pair":
        return pair();
      case "popup:start-recording":
        return startRecording(message.title);
      case "popup:stop-recording":
        return stopRecording();
      case "popup:list-guides": {
        const listed = await call("/guides");
        return listed.ok ? listed.data : { guides: [], error: listed.error };
      }
      case "popup:start-replay": {
        const state = await getReplay();
        const mode = message.mode ?? "follow";
        if (state) return stopReplay().then(() => startReplay(message.guideId, mode));
        return startReplay(message.guideId, mode);
      }
      default:
        return { ok: false, error: "unknown message" };
    }
  }
})();
