"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildVideoHtml = buildVideoHtml;
exports.toAnimatedHtml = toAnimatedHtml;
const annotations_1 = require("./annotations");
const customize_1 = require("./customize");
const TRANSITION_MS = {
    // Not zero: a keyframe pair needs two distinct offsets, and one frame at 60fps is as close
    // to an instant cut as a frame-sampled timeline can express.
    cut: 16,
    fade: 420,
    slide: 520,
};
/**
 * How far the slow push-in travels. The fit divides the available slot by this, so the
 * screenshot is exactly its share of the frame at the widest point of the zoom rather than
 * swelling over the caption at the end of each scene.
 */
const KEN_BURNS_ZOOM = 1.045;
/**
 * The cinematic camera (settings.motion === 'cinematic').
 *
 * Unlike the push-in, which scales the whole shot, the cinematic camera moves *inside* it:
 * the shot becomes a fixed, overflow-clipped viewport and an inner `.gt-cam` element carries
 * a translate+scale toward the step's target, with a drawn cursor that glides in and clicks.
 * Because the viewport never changes size, the fit needs no zoom reserve and the picture can
 * be examined at 2× without swelling over the caption.
 *
 * Everything below is computed here, at build time, from the annotations the recorder
 * measured — the same source `deriveAnnotations` uses, and under the same rule: a step with
 * no measured target gets the gentle push, never a confident zoom into a guessed spot.
 */
/**
 * Camera intensity presets (settings.camera). `maxZoom` caps how close the camera gets;
 * `hold`/`reach`/`leave` are scene-fraction offsets — hold wide until `hold`, arrive zoomed
 * at `reach`, start pulling out at `leave`. The cursor, click and keystroke timings in the
 * script are all derived from `reach`, so one preset moves the whole choreography together.
 */
const CINEMATIC_CAMERAS = {
    subtle: { maxZoom: 1.7, hold: 0.2, reach: 0.5, leave: 0.82 },
    standard: { maxZoom: 2.3, hold: 0.16, reach: 0.46, leave: 0.84 },
    close: { maxZoom: 3.0, hold: 0.13, reach: 0.42, leave: 0.87 },
};
/** Below this the travel is not worth the motion — the plain push reads better. */
const CINEMATIC_MIN_ZOOM = 1.18;
/** Where the cursor waits before the first measured step: out of the way, lower right. */
const CURSOR_HOME = { x: 72, y: 86 };
const clampRange = (value, min, max) => Math.min(Math.max(value, min), max);
const round3 = (value) => Math.round(value * 1000) / 1000;
/**
 * A box gives a rect; a bare arrow gives its tip. A badge alone is the unanchored corner
 * numeral, which is not a target. Returned without `fx`/`fy` — the scene loop threads those
 * from the previous plan.
 */
function cameraPlan(annotations, maxZoom) {
    const box = annotations.find((a) => a.kind === 'box');
    const arrow = annotations.find((a) => a.kind === 'arrow');
    let x, y, w, h;
    if (box && box.w && box.h) {
        x = box.x + box.w / 2;
        y = box.y + box.h / 2;
        w = box.w;
        h = box.h;
    }
    else if (arrow) {
        x = arrow.x;
        y = arrow.y;
        w = 0;
        h = 0;
    }
    else {
        return null;
    }
    // Close enough that the target reads, never so close the context is gone. The 0.21 floor
    // keeps a point target (an arrow tip) from zooming past the cap.
    const z = Math.min(maxZoom, 0.5 / Math.max(w, h, 0.21));
    if (z < CINEMATIC_MIN_ZOOM)
        return null;
    /**
     * The visible window at zoom z is 1/z of the image; clamping its centre keeps the camera on
     * the picture. That clamp also bounds the whole journey: interpolating translate and scale
     * linearly from (0, 1) to (t, z), the off-image overhang works out to s·|0.5−c|·z against a
     * budget of s·0.5·(z−1), and the clamp makes the first at most the second at every s — so
     * no frame between wide and zoomed ever shows the stage behind the screenshot.
     */
    const cx = clampRange(x, 0.5 / z, 1 - 0.5 / z);
    const cy = clampRange(y, 0.5 / z, 1 - 0.5 / z);
    return {
        z: round3(z),
        tx: round3((0.5 - cx) * z * 100),
        ty: round3((0.5 - cy) * z * 100),
        px: round3(clampRange(x, 0.02, 0.98) * 100),
        py: round3(clampRange(y, 0.02, 0.98) * 100),
    };
}
/**
 * The cursor and its click ripple, positioned at build time. The ripple takes the mark's own
 * colour so the click matches the arrow pointing at the same control; the cursor is drawn
 * with its hotspot at the viewBox origin, so `left/top` place the tip exactly on the target.
 */
function cursorMarkup(plan, annotations) {
    if (!plan)
        return '';
    const color = annotations.find((a) => a.color)?.color ?? '#e8453f';
    return (`<span class="gt-tap" style="left:${plan.px}%;top:${plan.py}%;border-color:${escapeAttr(color)}"></span>` +
        `<span class="gt-cur"><svg viewBox="0 0 20 22"><path d="M3 1.6 L3 16.8 L7.1 13.2 L9.6 19.3 L12.5 18.1 L10 12.1 L15.4 11.6 Z"/></svg></span>`);
}
/** Roles that mean "this step types into something", from the recorder's a11y anchor. */
const TYPING_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'textarea']);
/**
 * What the keystroke pill shows for a typing step, or null for no pill. The text is only
 * ever something the guide already says out loud — a redaction placeholder token from the
 * step's own prose, or the field's accessible label. Never a typed value: the guide is
 * structurally incapable of carrying one (§7.6), and this helper must stay that way too.
 */
function keystrokeLabel(step) {
    const token = /\{\{\s*([^{}]{1,40}?)\s*\}\}/.exec(step.body);
    if (token)
        return `{{${token[1]}}}`;
    const role = (step.a11y?.role || '').toLowerCase();
    if (TYPING_ROLES.has(role))
        return step.a11y?.name?.trim() || null;
    return null;
}
const THEMES = {
    /**
     * A rendered walkthrough is the reader's artifact and wears the brand — see
     * src/styles/00-tokens.css. Each theme takes the brand value that carries on its own ground:
     * the bright one on the dark frame, the deep one on the light frame. `onAccent` travels with
     * the accent rather than being assumed white, because the caption numeral sits on top of it.
     */
    dark: {
        bg: '#0b0e14',
        panel: 'rgba(255,255,255,0.04)',
        fg: '#e6edf3',
        muted: '#93a1ae',
        line: 'rgba(255,255,255,0.10)',
        accent: '#22b8d6',
        onAccent: '#0b0e14',
    },
    light: {
        bg: '#f1f5f9',
        panel: 'rgba(14,20,27,0.04)',
        fg: '#0e141b',
        muted: '#4f5d6b',
        line: 'rgba(14,20,27,0.10)',
        accent: '#0b6e96',
        onAccent: '#ffffff',
    },
};
/**
 * `sceneDurations`, when given, sets each step scene's length in milliseconds — the narrated
 * MP4 passes the paced timeline so a scene holds until its clip finishes. Without it every
 * scene gets `secondsPerStep`, which is also what the animated HTML and APNG always use:
 * they carry no audio, so there is nothing to pace against.
 */
function buildVideoHtml(guide, images, settings, sceneDurations, opts = {}) {
    const { width, height } = (0, customize_1.videoDimensions)(settings);
    const base = THEMES[settings.theme];
    const trans = TRANSITION_MS[settings.transition];
    const portrait = height > width;
    /**
     * Branding overrides the theme's accent but never its background or text colours — a brand
     * colour chosen for a white page can be unreadable as video chrome, and the accent is the
     * only slot where an arbitrary hex is safe. The logo rides on the title card.
     */
    const brand = guide.branding?.enabled ? guide.branding : null;
    const theme = brand ? { ...base, accent: brand.accent, onAccent: (0, customize_1.inkOn)(brand.accent) } : base;
    const scenes = [];
    let cursor = 0;
    if (settings.titleCard) {
        scenes.push({
            startMs: 0,
            endMs: customize_1.TITLE_CARD_MS,
            html: `
        <div class="title-card">
          <span class="card-glow"></span>
          ${brand?.logo ? `<img class="brand-mark" src="${escapeHtml(brand.logo)}" alt="" />` : ''}
          <p class="eyebrow">${escapeHtml(brand?.organisation || guide.audience || 'Step-by-step walkthrough')}</p>
          <h1>${escapeHtml(guide.title)}</h1>
          ${guide.intent ? `<p class="lede">${escapeHtml(guide.intent)}</p>` : ''}
          <p class="meta">${guide.steps.length} steps${guide.estimatedMinutes ? ` · about ${guide.estimatedMinutes} min` : ''}</p>
        </div>`,
        });
        cursor = customize_1.TITLE_CARD_MS;
    }
    const stepMs = Math.round(settings.secondsPerStep * 1000);
    const cinematic = settings.motion === 'cinematic';
    // The cursor glides in from wherever it last clicked, so the pointer reads as one actor
    // moving through the walkthrough rather than teleporting per scene.
    let cursorFrom = { x: CURSOR_HOME.x, y: CURSOR_HOME.y };
    guide.steps.forEach((step, index) => {
        const sceneMs = Math.max(1, Math.round(sceneDurations?.[index] ?? stepMs));
        const image = step.screenshot ? images.get(step.id) : undefined;
        const annotations = settings.annotations ? step.annotations : [];
        // The camera reads the *measured* marks, not the displayed ones — switching annotation
        // drawing off should not also freeze the camera.
        const planned = cinematic && image ? cameraPlan(step.annotations, CINEMATIC_CAMERAS[settings.camera].maxZoom) : null;
        const plan = planned ? { ...planned, fx: cursorFrom.x, fy: cursorFrom.y } : null;
        if (plan)
            cursorFrom = { x: plan.px, y: plan.py };
        // The pill needs a click moment to hang off, so it only appears alongside a camera plan.
        const keys = plan ? keystrokeLabel(step) : null;
        scenes.push({
            startMs: cursor,
            endMs: cursor + sceneMs,
            html: `
        <div class="frame">
          ${image
                ? `<div class="shot-wrap"><span class="gt-shot"><span class="gt-cam"${plan ? ` data-cam="${escapeAttr(JSON.stringify(plan))}"` : ''}><img src="${image}" alt="" /><!--
               -->${(0, annotations_1.annotationOverlayMarkup)(annotations)}${cursorMarkup(plan, step.annotations)}</span><!--
               -->${cinematic ? '<span class="gt-sheen"></span>' : ''}</span><!--
               -->${keys ? `<span class="gt-keys">${escapeHtml(keys)}</span>` : ''}</div>`
                : `<div class="shot-wrap shot-missing"><span>No screenshot was captured for this step.</span></div>`}
          ${settings.captions
                ? `<div class="caption">
                   <span class="num">${index + 1}</span>
                   <div class="caption-text">
                     <h2>${escapeHtml(step.title)}</h2>
                     ${step.body ? `<p>${escapeHtml(clip(step.body, portrait ? 150 : 210))}</p>` : ''}
                   </div>
                 </div>`
                : ''}
        </div>`,
        });
        cursor += sceneMs;
    });
    if (settings.outroCard) {
        /**
         * The sign-off. Whitelabel hides our name here exactly as it does in every other export
         * (showAttribution drops the line and nothing else); a branded guide signs with the
         * organisation instead, and an unbranded one signs with us.
         */
        const attribution = brand && !brand.showAttribution ? brand.organisation : 'Made with 1ShowcaseTool';
        scenes.push({
            startMs: cursor,
            endMs: cursor + customize_1.OUTRO_CARD_MS,
            html: `
        <div class="title-card outro-card">
          <span class="card-glow"></span>
          ${brand?.logo ? `<img class="brand-mark" src="${escapeHtml(brand.logo)}" alt="" />` : ''}
          <h1>${escapeHtml(guide.title)}</h1>
          ${attribution ? `<p class="meta">${escapeHtml(attribution)}</p>` : ''}
        </div>`,
        });
        cursor += customize_1.OUTRO_CARD_MS;
    }
    // The total falls out of the scenes rather than being computed twice — with paced scenes
    // there is no closed form to agree with, only the timeline that was actually built.
    const totalMs = Math.max(1, cursor);
    const sceneMarkup = scenes
        .map((scene, index) => `<section class="scene" data-start="${scene.startMs}" data-end="${scene.endMs}" style="z-index:${index + 1}">${scene.html}</section>`)
        .join('\n');
    return `<!doctype html>
<html lang="${escapeAttr(guide.language || 'en')}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(guide.title)}</title>
<style>
  /* First, so the frame rules below can override the shared overlay defaults. */
${annotations_1.ANNOTATION_CSS}
  :root {
    --bg: ${theme.bg}; --panel: ${theme.panel}; --fg: ${theme.fg}; --muted: ${theme.muted};
    --line: ${theme.line}; --accent: ${theme.accent}; --on-accent: ${theme.onAccent};
    --unit: ${Math.round(Math.min(width, height) / 100)}px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .stage { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; }

  /* A soft field behind everything, so a light screenshot never floats on flat colour. */
  .stage::before {
    content: ''; position: absolute; inset: -10%;
    background:
      radial-gradient(60% 50% at 18% 10%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 70%),
      radial-gradient(50% 45% at 84% 88%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 72%);
    opacity: .75;
  }

  .topbar {
    position: absolute; left: calc(var(--unit) * 5); right: calc(var(--unit) * 5); top: calc(var(--unit) * 3.5);
    display: flex; align-items: center; gap: calc(var(--unit) * 1.6);
    font-size: calc(var(--unit) * 2.1); color: var(--muted); letter-spacing: .01em; z-index: 900;
  }
  .topbar .dot { width: calc(var(--unit) * 1.5); height: calc(var(--unit) * 1.5); border-radius: 50%; background: var(--accent); flex: 0 0 auto; }
  .topbar .name { color: var(--fg); font-weight: 600; }
  .topbar .spacer { flex: 1 1 auto; }

  .scene { position: absolute; inset: 0; display: grid; place-items: center; opacity: 0; }

  .frame {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: calc(var(--unit) * 3.4);
    width: 100%; height: 100%;
    padding: calc(var(--unit) * 10) calc(var(--unit) * 6) calc(var(--unit) * 7);
  }
  /**
   * The shot is taken out of flow so the space available to it is decided purely by the
   * frame and the caption. __gtFitShots then sizes it in exact pixels — a 400px crop fills
   * a 1080p frame instead of sitting marooned in the middle of it, and nothing is ever
   * distorted, because the box is set to the image's own ratio rather than clamped into shape.
   */
  .shot-wrap { position: relative; flex: 1 1 auto; min-height: 0; width: 100%; }
  /* Child selector, so this beats the shared .gt-shot default regardless of rule order. */
  .shot-wrap > .gt-shot {
    display: block; position: absolute; inset: 0; margin: auto;
    border-radius: calc(var(--unit) * 1.4);
    box-shadow: 0 calc(var(--unit) * 2.4) calc(var(--unit) * 6) rgba(0,0,0,.42);
  }
  /* The camera. Inert except in cinematic mode, where its transform is the zoom. */
  .gt-cam { position: absolute; inset: 0; }
  /* Cinematic: the shot is a fixed viewport and the camera moves inside it. The wrap carries
     perspective so the card can breathe in 3D — the float never lets the product sit dead. */
  .cine .shot-wrap { perspective: calc(var(--unit) * 160); }
  .cine .shot-wrap > .gt-shot { overflow: hidden; }
  /* A specular pass over the glass — above everything inside the card, clipped with it. */
  .gt-sheen {
    position: absolute; inset: 0; pointer-events: none; z-index: 60; opacity: 0;
    background: linear-gradient(115deg, transparent 40%, rgba(255, 255, 255, 0.10) 50%, transparent 60%);
    background-size: 260% 100%; background-position: 130% 0;
  }
  .gt-shot img {
    display: block; width: 100%; height: 100%;
    border-radius: calc(var(--unit) * 1.4); border: 1px solid var(--line);
  }
  /* The drawn cursor and its click ripple. Inside the camera, so both travel with the zoom. */
  .gt-cur {
    position: absolute; width: calc(var(--unit) * 3.2); opacity: 0; z-index: 40;
    filter: drop-shadow(0 calc(var(--unit) * 0.2) calc(var(--unit) * 0.5) rgba(0,0,0,.45));
  }
  .gt-cur svg { display: block; width: 100%; height: auto; overflow: visible; transform-origin: 18% 8%; }
  .gt-cur path { fill: #ffffff; stroke: rgba(14,20,27,0.6); stroke-width: 1.3; stroke-linejoin: round; }
  .gt-tap {
    position: absolute; width: calc(var(--unit) * 7); height: calc(var(--unit) * 7);
    border-radius: 50%; border: calc(var(--unit) * 0.35) solid #e8453f;
    opacity: 0; z-index: 39; transform: translate(-50%, -50%);
  }
  /* The keystroke pill: outside the camera on purpose, so it holds still while the shot
     zooms — it is a caption about the typing, not part of the recorded pixels. */
  .gt-keys {
    position: absolute; left: 50%; bottom: calc(var(--unit) * 3); z-index: 45;
    transform: translateX(-50%) translateY(30%); opacity: 0;
    max-width: 86%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: 'SF Mono', 'Cascadia Mono', 'Roboto Mono', Menlo, Consolas, monospace;
    font-size: calc(var(--unit) * 2); line-height: 1.4; color: #ffffff;
    background: rgba(10, 14, 20, 0.78); border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: calc(var(--unit) * 1); padding: calc(var(--unit) * 0.9) calc(var(--unit) * 1.8);
    backdrop-filter: blur(4px);
  }
  .shot-missing {
    display: grid; place-items: center;
    color: var(--muted); font-size: calc(var(--unit) * 2.4);
    border: 1px dashed var(--line); border-radius: calc(var(--unit) * 1.4);
  }

  .caption {
    flex: 0 0 auto; display: flex; gap: calc(var(--unit) * 2.4); align-items: flex-start;
    width: min(100%, calc(var(--unit) * ${portrait ? 92 : 76}));
    background: var(--panel); border: 1px solid var(--line);
    border-radius: calc(var(--unit) * 1.8);
    padding: calc(var(--unit) * 2.6) calc(var(--unit) * 3);
    backdrop-filter: blur(6px);
  }
  .caption .num {
    flex: 0 0 auto; display: grid; place-items: center;
    width: calc(var(--unit) * 4.6); height: calc(var(--unit) * 4.6); border-radius: 50%;
    background: var(--accent); color: var(--on-accent); font-weight: 700; font-size: calc(var(--unit) * 2.3);
  }
  .caption h2 { font-size: calc(var(--unit) * ${portrait ? 3.4 : 3}); line-height: 1.2; letter-spacing: -.015em; }
  .caption p { margin-top: calc(var(--unit) * 1); font-size: calc(var(--unit) * ${portrait ? 2.4 : 2.1}); line-height: 1.45; color: var(--muted); }

  .title-card { position: relative; text-align: center; padding: 0 calc(var(--unit) * 10); max-width: calc(var(--unit) * 88); }
  /* A soft accent pool behind the type, drifted slowly by the timeline — the keynote stage light. */
  .card-glow {
    position: absolute; left: 50%; top: 46%; z-index: -1;
    width: calc(var(--unit) * 74); height: calc(var(--unit) * 44);
    transform: translate(-50%, -50%); border-radius: 50%;
    background: radial-gradient(50% 50% at 50% 50%, color-mix(in srgb, var(--accent) 26%, transparent), transparent 72%);
    filter: blur(calc(var(--unit) * 1.6));
  }
  /**
   * The headline is painted by its own gradient so a highlight can sweep through the type —
   * background-position is what the timeline animates. The gradient's resting state is the
   * plain foreground colour, so a browser without background-clip:text just shows normal text.
   */
  .title-card h1 {
    background: linear-gradient(100deg,
      var(--fg) 38%, color-mix(in srgb, var(--accent) 55%, var(--fg)) 50%, var(--fg) 62%);
    background-size: 240% 100%; background-position: 130% 0;
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .title-card .brand-mark { display: block; margin: 0 auto calc(var(--unit) * 3.2); max-height: calc(var(--unit) * 8);
    max-width: calc(var(--unit) * 34); width: auto; height: auto; object-fit: contain; }
  .title-card .eyebrow { text-transform: uppercase; letter-spacing: .16em; font-size: calc(var(--unit) * 1.9); color: var(--accent); font-weight: 650; }
  .title-card h1 { margin-top: calc(var(--unit) * 2.4); font-size: calc(var(--unit) * ${portrait ? 7 : 6}); line-height: 1.08; letter-spacing: -.03em; }
  .title-card .lede { margin-top: calc(var(--unit) * 2.6); font-size: calc(var(--unit) * 2.7); line-height: 1.45; color: var(--muted); }
  .title-card .meta { margin-top: calc(var(--unit) * 3.4); font-size: calc(var(--unit) * 2.1); color: var(--muted); }

  .progress { position: absolute; left: 0; right: 0; bottom: 0; height: calc(var(--unit) * 0.7); background: var(--line); z-index: 950; }
  .progress span { display: block; height: 100%; background: var(--accent); transform-origin: left center; transform: scaleX(0); }
  /**
   * The free-tier mark. Inside .stage on purpose — the exporter seeks and screenshots the stage,
   * so anything outside it is chrome that never reaches a frame. Sized in --unit like the rest of
   * the chrome, so it holds its proportions at 720p and 1080p and in every aspect.
   */
  .watermark {
    position: absolute; right: calc(var(--unit) * 2.4); bottom: calc(var(--unit) * 2.4); z-index: 940;
    padding: calc(var(--unit) * 0.9) calc(var(--unit) * 1.8);
    border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--fg);
    font-size: calc(var(--unit) * 1.5); opacity: .82; letter-spacing: .01em; white-space: nowrap;
  }
</style>
</head>
<body>
<div class="stage${settings.motion === 'cinematic' ? ' cine' : ''}">
  <div class="topbar">
    <span class="dot"></span>
    <span class="name">${escapeHtml(clip(guide.title, 70))}</span>
    <span class="spacer"></span>
    <span>1ShowcaseTool</span>
  </div>
  ${sceneMarkup}
  ${opts.watermark ? `<div class="watermark">${escapeHtml(opts.watermark)}</div>` : ''}
  ${settings.progressBar ? '<div class="progress"><span></span></div>' : ''}
</div>
${annotations_1.ANNOTATION_SCRIPT}
<script>(function(){
  var TOTAL = ${totalMs};
  var TRANS = ${trans};
  var MOTION = ${JSON.stringify(settings.motion)};
  /** The camera preset's arc. Every cinematic timing below derives from CAM.reach. */
  var CAM = ${JSON.stringify(CINEMATIC_CAMERAS[settings.camera])};
  var SLIDE = ${settings.transition === 'slide'};
  /** Peak of the push-in. Kept here because the fit has to reserve room for it. */
  var ZOOM = MOTION === 'kenburns' ? ${KEN_BURNS_ZOOM} : 1;
  var anims = [];

  /**
   * Size each screenshot to fill its share of the frame, at its own aspect ratio.
   *
   * The slot is divided by the push-in's peak zoom, so the picture is at its largest exactly
   * when the zoom is at its widest. Fitting the untransformed box instead would let the
   * screenshot swell past the caption at the end of every scene.
   */
  function fitShots(){
    var shots = document.querySelectorAll('.gt-shot');
    for (var i = 0; i < shots.length; i++) {
      var shot = shots[i], img = shot.querySelector('img');
      if (!img || !img.naturalWidth || !img.naturalHeight) continue;
      // offsetWidth/Height, not getBoundingClientRect: the parent is inside a scene that may
      // already be mid-transform, and this needs layout pixels rather than painted ones.
      var availW = shot.parentElement.offsetWidth / ZOOM, availH = shot.parentElement.offsetHeight / ZOOM;
      if (availW <= 0 || availH <= 0) continue;
      var ar = img.naturalWidth / img.naturalHeight;
      var w = availW, h = w / ar;
      if (h > availH) { h = availH; w = h * ar; }
      shot.style.width = w + 'px';
      shot.style.height = h + 'px';
    }
    if (window.__gtDrawAnnotations) window.__gtDrawAnnotations();
  }
  window.__gtFitShots = fitShots;
  window.addEventListener('resize', fitShots);
  for (var n = 0; n < document.images.length; n++) document.images[n].addEventListener('load', fitShots);
  // Web fonts change how the caption wraps, which changes how much room the shot has. Fit
  // again once they have settled, or the picture is sized against a caption height that no
  // longer exists and overhangs its share of the frame.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitShots);
  window.addEventListener('load', fitShots);
  fitShots();

  function add(el, frames, timing){
    if (!el || !el.animate) return;
    var anim = el.animate(frames, Object.assign({ fill: 'both', easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }, timing));
    anim.pause();
    anims.push(anim);
  }

  var scenes = document.querySelectorAll('.scene');
  for (var i = 0; i < scenes.length; i++) {
    var scene = scenes[i];
    var start = parseFloat(scene.getAttribute('data-start'));
    var end = parseFloat(scene.getAttribute('data-end'));

    /**
     * One animation per scene, spanning its own window plus a transition either side, so the
     * fills do the hiding: before the delay it holds opacity 0, after it ends it holds 0
     * again. Two competing animations on one property would fight over their fill regions.
     */
    var t = Math.min(TRANS, (end - start) / 2 - 1);
    if (!(t > 0)) t = 1;
    var delay = Math.max(0, start - t);
    var duration = (end + t) - delay;
    var f1 = t / duration, f2 = 1 - t / duration;

    var frames = SLIDE
      ? [
          { opacity: 0, transform: 'translateX(3.5%)', offset: 0 },
          { opacity: 1, transform: 'translateX(0)', offset: f1 },
          { opacity: 1, transform: 'translateX(0)', offset: f2 },
          { opacity: 0, transform: 'translateX(-3.5%)', offset: 1 }
        ]
      : [
          { opacity: 0, offset: 0 },
          { opacity: 1, offset: f1 },
          { opacity: 1, offset: f2 },
          { opacity: 0, offset: 1 }
        ];
    add(scene, frames, { delay: delay, duration: duration, easing: 'linear' });

    if (MOTION === 'kenburns') {
      // The transform lives on the wrapper, not the image, so the annotation overlay is
      // inside it and travels with the zoom instead of sliding off the target.
      var shot = scene.querySelector('.gt-shot');
      var into = i % 2 === 0;
      add(shot,
        [{ transform: into ? 'scale(1)' : 'scale(' + ZOOM + ')' }, { transform: into ? 'scale(' + ZOOM + ')' : 'scale(1)' }],
        { delay: start, duration: end - start, easing: 'cubic-bezier(0.4, 0, 0.6, 1)' }
      );
    }

    if (MOTION === 'cinematic') {
      var cam = scene.querySelector('.gt-cam');
      var plan = null;
      if (cam) { try { plan = JSON.parse(cam.getAttribute('data-cam') || 'null'); } catch (e) {} }
      var sceneMs = end - start;

      // The float: the card breathes in perspective and never sits dead still. On the outer
      // shot, not the camera, so the zoom composes with it instead of fighting it.
      var shotEl = scene.querySelector('.gt-shot');
      if (shotEl) {
        add(shotEl, [
          { transform: 'translateY(0.35%) rotateX(1.1deg)', offset: 0, easing: 'ease-in-out' },
          { transform: 'translateY(-0.45%) rotateX(-0.5deg)', offset: 0.52, easing: 'ease-in-out' },
          { transform: 'translateY(0.35%) rotateX(1.1deg)', offset: 1 }
        ], { delay: start, duration: sceneMs, easing: 'linear' });
      }
      // The specular pass: one sweep of light across the glass as the camera settles.
      var sheen = scene.querySelector('.gt-sheen');
      if (sheen) {
        add(sheen, [
          { backgroundPosition: '130% 0', opacity: 0, offset: 0 },
          { backgroundPosition: '130% 0', opacity: 0, offset: 0.14 },
          { backgroundPosition: '110% 0', opacity: 0.85, offset: 0.22, easing: 'cubic-bezier(0.35, 0, 0.3, 1)' },
          { backgroundPosition: '-30% 0', opacity: 0.85, offset: 0.52 },
          { backgroundPosition: '-30% 0', opacity: 0, offset: 0.62 },
          { backgroundPosition: '-30% 0', opacity: 0, offset: 1 }
        ], { delay: start, duration: sceneMs, easing: 'linear' });
      }

      if (cam && plan) {
        /**
         * One arc per scene: open wide so the viewer orients, glide into the target, dwell
         * on it while the cursor clicks, pull back out before the transition hands over.
         * Per-keyframe easing carries each glide; the holds between them are value-identical
         * so the linear default costs nothing. All offsets hang off the preset's arc.
         */
        var wide = 'translate(0%, 0%) scale(1)';
        var zoomed = 'translate(' + plan.tx + '%, ' + plan.ty + '%) scale(' + plan.z + ')';
        add(cam, [
          { transform: wide, offset: 0 },
          { transform: wide, offset: CAM.hold, easing: 'cubic-bezier(0.45, 0, 0.18, 1)' },
          { transform: zoomed, offset: CAM.reach },
          { transform: zoomed, offset: CAM.leave, easing: 'cubic-bezier(0.5, 0, 0.35, 1)' },
          { transform: wide, offset: 1 }
        ], { delay: start, duration: sceneMs, easing: 'linear' });

        // The cursor arrives just before the camera does, clicks at the dwell, and bows out
        // ahead of the transition. left/top rather than transform, so the click dip below
        // can own the cursor's own transform without a fight.
        var cur = scene.querySelector('.gt-cur');
        if (cur) {
          add(cur, [
            { left: plan.fx + '%', top: plan.fy + '%', offset: 0 },
            { left: plan.fx + '%', top: plan.fy + '%', offset: CAM.hold - 0.02, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
            { left: plan.px + '%', top: plan.py + '%', offset: CAM.reach - 0.01 },
            { left: plan.px + '%', top: plan.py + '%', offset: 1 }
          ], { delay: start, duration: sceneMs, easing: 'linear' });
          add(cur, [
            { opacity: 0, offset: 0 }, { opacity: 0, offset: 0.1 }, { opacity: 1, offset: 0.18 },
            { opacity: 1, offset: 0.86 }, { opacity: 0, offset: 0.94 }, { opacity: 0, offset: 1 }
          ], { delay: start, duration: sceneMs, easing: 'linear' });
          // The press: a quick dip about the hotspot at the moment the ripple fires.
          add(cur.querySelector('svg'), [
            { transform: 'scale(1)', offset: 0 }, { transform: 'scale(1)', offset: CAM.reach + 0.01 },
            { transform: 'scale(0.8)', offset: CAM.reach + 0.04 }, { transform: 'scale(1)', offset: CAM.reach + 0.09 },
            { transform: 'scale(1)', offset: 1 }
          ], { delay: start, duration: sceneMs, easing: 'linear' });
        }

        var tap = scene.querySelector('.gt-tap');
        if (tap) {
          add(tap, [
            { transform: 'translate(-50%, -50%) scale(0.3)', opacity: 0, offset: 0 },
            { transform: 'translate(-50%, -50%) scale(0.3)', opacity: 0, offset: CAM.reach + 0.03 },
            { transform: 'translate(-50%, -50%) scale(0.55)', opacity: 0.85, offset: CAM.reach + 0.06, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
            { transform: 'translate(-50%, -50%) scale(1)', opacity: 0, offset: CAM.reach + 0.2 },
            { transform: 'translate(-50%, -50%) scale(1)', opacity: 0, offset: 1 }
          ], { delay: start, duration: sceneMs, easing: 'linear' });
        }

        // The typing pill pops up once the click has landed and stays through the dwell.
        var keys = scene.querySelector('.gt-keys');
        if (keys) {
          add(keys, [
            { opacity: 0, transform: 'translateX(-50%) translateY(30%)', offset: 0 },
            { opacity: 0, transform: 'translateX(-50%) translateY(30%)', offset: CAM.reach + 0.06, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
            { opacity: 1, transform: 'translateX(-50%) translateY(0%)', offset: CAM.reach + 0.14 },
            { opacity: 1, transform: 'translateX(-50%) translateY(0%)', offset: CAM.leave },
            { opacity: 0, transform: 'translateX(-50%) translateY(0%)', offset: Math.min(CAM.leave + 0.08, 0.98) },
            { opacity: 0, transform: 'translateX(-50%) translateY(0%)', offset: 1 }
          ], { delay: start, duration: sceneMs, easing: 'linear' });
        }
      } else if (cam) {
        // No measured target: the clipped equivalent of the slow push, alternating direction.
        var pushIn = i % 2 === 0;
        add(cam,
          [{ transform: pushIn ? 'scale(1)' : 'scale(1.06)' }, { transform: pushIn ? 'scale(1.06)' : 'scale(1)' }],
          { delay: start, duration: sceneMs, easing: 'cubic-bezier(0.4, 0, 0.6, 1)' }
        );
      }
    }

    var caption = scene.querySelector('.caption, .title-card');
    add(caption,
      [{ opacity: 0, transform: 'translateY(' + (SLIDE ? 0 : 14) + 'px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { delay: start, duration: Math.min(720, (end - start) * 0.45) }
    );

    /**
     * The keynote treatment for the title and outro cards: the headline tracks in from wide
     * spacing while a highlight sweeps through the type, the supporting lines stagger up
     * behind it, and the stage light drifts. All child animations inside the scene's window,
     * so they seek exactly like everything else.
     */
    var card = scene.querySelector('.title-card');
    if (card) {
      var head = card.querySelector('h1');
      add(head, [
        { opacity: 0, letterSpacing: '0.09em', transform: 'translateY(4%) scale(1.03)', offset: 0, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
        { opacity: 1, letterSpacing: '-0.03em', transform: 'translateY(0) scale(1)', offset: 0.42 },
        { opacity: 1, letterSpacing: '-0.03em', transform: 'translateY(0) scale(1)', offset: 1 }
      ], { delay: start, duration: end - start, easing: 'linear' });
      add(head, [
        { backgroundPosition: '130% 0', offset: 0 },
        { backgroundPosition: '130% 0', offset: 0.3, easing: 'cubic-bezier(0.4, 0, 0.3, 1)' },
        { backgroundPosition: '-30% 0', offset: 0.85 },
        { backgroundPosition: '-30% 0', offset: 1 }
      ], { delay: start, duration: end - start, easing: 'linear' });
      var lines = card.querySelectorAll('.brand-mark, .eyebrow, .lede, .meta');
      for (var L = 0; L < lines.length; L++) {
        var inAt = Math.min(0.14 + L * 0.09, 0.55);
        add(lines[L], [
          { opacity: 0, transform: 'translateY(12px)', offset: 0 },
          { opacity: 0, transform: 'translateY(12px)', offset: inAt, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
          { opacity: 1, transform: 'translateY(0)', offset: Math.min(inAt + 0.24, 0.85) },
          { opacity: 1, transform: 'translateY(0)', offset: 1 }
        ], { delay: start, duration: end - start, easing: 'linear' });
      }
      add(card.querySelector('.card-glow'), [
        { transform: 'translate(-50%, -50%) scale(0.88)', opacity: 0.55, offset: 0, easing: 'ease-in-out' },
        { transform: 'translate(-46%, -52%) scale(1.06)', opacity: 1, offset: 0.6, easing: 'ease-in-out' },
        { transform: 'translate(-50%, -50%) scale(0.98)', opacity: 0.85, offset: 1 }
      ], { delay: start, duration: end - start, easing: 'linear' });
    }
  }

  add(document.querySelector('.progress span'), [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: TOTAL, easing: 'linear' });

  window.__gtTotal = TOTAL;
  window.__gtSeek = function(ms){
    var t = Math.max(0, Math.min(TOTAL, ms));
    for (var i = 0; i < anims.length; i++) { try { anims[i].currentTime = t; } catch (e) {} }
    if (window.__gtDrawAnnotations) window.__gtDrawAnnotations();
  };
  /** The no-FFmpeg path: same document, left running and looping instead of sampled. */
  window.__gtPlay = function(){
    for (var i = 0; i < anims.length; i++) { try { anims[i].currentTime = 0; anims[i].play(); } catch (e) {} }
    window.setTimeout(window.__gtPlay, TOTAL + 400);
  };
  window.__gtSeek(0);
})();</script>
</body>
</html>`;
}
/**
 * The animated document as a standalone file: identical timeline, plus autoplay and a replay
 * control. Needs no FFmpeg, no player, and nothing installed — it is a guide you can email.
 */
function toAnimatedHtml(guide, images, settings, opts = {}) {
    const { width, height } = (0, customize_1.videoDimensions)(settings);
    const document = buildVideoHtml(guide, images, settings, undefined, opts);
    const shell = `
<style>
  /* Fit the fixed-size stage to whatever window it is opened in. The divisor carries px on
     purpose: length ÷ number is still a length, which scale() rejects, and the whole
     declaration silently drops — the export opens cropped to the stage's top-left corner.
     length ÷ length is a plain number, which is what a scale factor is. */
  /* place-content, not place-items: the implicit track is sized by the stage itself, so item
     alignment inside it is a no-op — the track is what has to be centred in the window. */
  html, body { width: 100% !important; height: 100% !important; background: ${THEMES[settings.theme].bg}; display: grid; place-content: center; }
  .stage { transform: scale(min(calc(100vw / ${width}px), calc(100vh / ${height}px))); transform-origin: center center; flex: 0 0 auto; }
  .replay {
    position: fixed; right: 18px; bottom: 18px; z-index: 999;
    font: 500 13px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: ${THEMES[settings.theme].fg}; background: ${THEMES[settings.theme].panel};
    border: 1px solid ${THEMES[settings.theme].line}; border-radius: 8px; padding: 8px 12px; cursor: pointer;
  }
</style>
<button class="replay" onclick="window.__gtPlay()">Replay</button>
<script>window.addEventListener('load', function(){
  /**
   * prefers-reduced-motion: the reader opts into motion instead of being served it. Frame
   * zero is deliberately an empty stage (the intro fades up from it), so hold a readable
   * frame instead — the Replay button still plays the walkthrough on request.
   */
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { window.__gtSeek(900); return; }
  window.setTimeout(window.__gtPlay, 250);
});</script>
</body>`;
    return document.replace('</body>', shell);
}
function clip(value, max) {
    const clean = value.trim().replace(/\s+/g, ' ');
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
function escapeAttr(value) {
    return escapeHtml(value);
}
//# sourceMappingURL=videoTemplate.js.map