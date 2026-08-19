(() => {
  // extension-showcasetool/src/sw/eligibility.ts
  function displayOrigin(origin) {
    return origin.replace(/^https?:\/\//, "").replace(/\/\*$/, "");
  }

  // extension-showcasetool/src/popup/index.ts
  var dot = document.getElementById("dot");
  var appState = document.getElementById("appstate");
  var panel = document.getElementById("panel");
  var errBox = document.getElementById("err");
  function ask(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        void chrome.runtime.lastError;
        resolve(response);
      });
    });
  }
  function showError(message) {
    if (message) {
      errBox.textContent = message;
      errBox.hidden = false;
    } else {
      errBox.hidden = true;
    }
  }
  function button(label, className, onClick, disabled = false) {
    const el = document.createElement("button");
    el.textContent = label;
    el.className = className;
    el.disabled = disabled;
    el.addEventListener("click", onClick);
    return el;
  }
  function zone(phase) {
    const el = document.createElement("div");
    el.className = phase === "neutral" ? "zone" : `zone zone-${phase}`;
    panel.append(el);
    return el;
  }
  function note(text, className = "state") {
    const el = document.createElement("p");
    el.className = className;
    el.textContent = text;
    return el;
  }
  async function requestSite(originPattern) {
    try {
      return await chrome.permissions.request({ origins: [originPattern] });
    } catch (err) {
      showError(err.message);
      return false;
    }
  }
  async function render() {
    const status = await ask({ type: "popup:status" });
    panel.replaceChildren();
    if (!status) {
      appState.textContent = "Extension error";
      return;
    }
    if (!status.appReachable) {
      dot.className = "dot";
      appState.textContent = "1ShowcaseTool is not running";
      panel.append(note("Open the 1ShowcaseTool desktop app, then reopen this popup."), button("Check again", "ghost", () => void render()));
      return;
    }
    if (!status.paired) {
      dot.className = "dot";
      appState.textContent = "Not connected";
      panel.append(
        note("Connect this extension to the app. You will be asked to approve it in the 1ShowcaseTool window."),
        button("Connect", "primary", () => {
          void (async () => {
            showError();
            const result = await ask({ type: "popup:pair" });
            if (!result?.ok) showError(result?.error ?? "pairing failed");
            await render();
          })();
        })
      );
      return;
    }
    if (status.recording) {
      dot.className = "dot rec";
      appState.textContent = "Recording";
      zone("record").append(
        note("Click through the flow exactly as your users will. Every click and page change is captured."),
        button("Stop recording", "danger", () => {
          void (async () => {
            const result = await ask({ type: "popup:stop-recording" });
            if (!result?.ok) showError(result?.error);
            await render();
          })();
        })
      );
      zone("neutral").append(note("Following a guide is unavailable while recording.", "empty"));
      return;
    }
    dot.className = "dot on";
    appState.textContent = status.replaying ? "Running a guide" : "Connected";
    if (status.replaying) {
      zone("follow").append(
        note("A guide is driving this tab. The overlay will point at each step as you go."),
        button("Stop the guide", "danger", () => {
          void (async () => {
            await ask({ type: "replay:finished" });
            await render();
          })();
        })
      );
      zone("neutral").append(note("Recording is unavailable while a guide is running.", "empty"));
    } else {
      renderRecordSection(status);
    }
    await renderGuides();
    await renderSites();
  }
  function renderRecordSection(status) {
    const host = zone("record");
    const label = document.createElement("label");
    label.textContent = "Record a new flow";
    host.append(label);
    if (status.ineligibleReason) {
      host.append(note(status.ineligibleReason, "empty"));
      return;
    }
    if (!status.canRecordHere) {
      const site = status.currentHostname ?? "this site";
      host.append(
        note(`1ShowcaseTool needs your permission to record ${site}. Chrome will ask you to confirm.`),
        button(`Allow recording on ${site}`, "primary", () => {
          void (async () => {
            showError();
            if (!status.currentOrigin) {
              showError("this tab has no address that can be granted");
              return;
            }
            const granted = await requestSite(status.currentOrigin);
            if (!granted) showError("permission was not granted");
            await render();
          })();
        })
      );
      return;
    }
    const input = document.createElement("input");
    input.placeholder = "e.g. Connect Google Search Console";
    input.maxLength = 120;
    host.append(
      input,
      button("Start recording", "primary", () => {
        void (async () => {
          showError();
          const result = await ask({
            type: "popup:start-recording",
            title: input.value.trim() || status.currentHostname || "Untitled flow"
          });
          if (!result?.ok) showError(result?.error);
          await render();
        })();
      })
    );
  }
  async function renderGuides() {
    const host = zone("follow");
    const guidesLabel = document.createElement("label");
    guidesLabel.textContent = "Follow a guide";
    host.append(guidesLabel);
    const listed = await ask({ type: "popup:list-guides" });
    if (listed?.error) showError(listed.error);
    const guides = listed?.guides ?? [];
    if (!guides.length) {
      host.append(note("No guides yet. Record a flow, review the redactions, and generate one.", "empty"));
      return;
    }
    const list = document.createElement("ul");
    list.className = "guides";
    for (const guide of guides) {
      const item = document.createElement("li");
      const btn = document.createElement("button");
      btn.append(document.createTextNode(guide.title));
      const meta = document.createElement("small");
      meta.textContent = `${guide.stepCount} steps`;
      btn.append(meta);
      btn.addEventListener("click", () => {
        void (async () => {
          showError();
          const result = await ask({ type: "popup:start-replay", guideId: guide.id });
          if (!result?.ok) showError(result?.error);
          else window.close();
        })();
      });
      const check = document.createElement("button");
      check.className = "guide-check";
      check.textContent = "Check";
      check.title = "Walk this guide yourself and record which steps still match the site";
      check.addEventListener("click", () => {
        void (async () => {
          showError();
          const result = await ask({ type: "popup:start-replay", guideId: guide.id, mode: "check" });
          if (!result?.ok) showError(result?.error);
          else window.close();
        })();
      });
      item.append(btn, check);
      list.append(item);
    }
    host.append(list);
  }
  async function renderSites() {
    const listed = await ask({ type: "popup:list-sites" });
    const sites = listed?.sites ?? [];
    if (!sites.length) return;
    panel.append(document.createElement("hr"));
    const label = document.createElement("label");
    label.textContent = `Sites you've allowed (${sites.length})`;
    panel.append(label);
    const list = document.createElement("ul");
    list.className = "sites";
    for (const origin of sites) {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.className = "site-host";
      name.textContent = displayOrigin(origin);
      name.title = origin;
      const remove = document.createElement("button");
      remove.className = "site-remove";
      remove.textContent = "Remove";
      remove.title = `Revoke access to ${origin}`;
      remove.addEventListener("click", () => {
        void (async () => {
          showError();
          const result = await ask({ type: "popup:remove-site", origin });
          if (!result?.ok) showError("Chrome would not revoke that permission");
          await render();
        })();
      });
      item.append(name, remove);
      list.append(item);
    }
    panel.append(list);
  }
  chrome.permissions.onAdded.addListener(() => void render());
  chrome.permissions.onRemoved.addListener(() => void render());
  void render();
})();
