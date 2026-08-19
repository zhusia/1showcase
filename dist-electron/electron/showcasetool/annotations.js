"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ANNOTATION_SCRIPT = exports.ANNOTATION_CSS = void 0;
exports.deriveAnnotations = deriveAnnotations;
exports.annotationOverlayMarkup = annotationOverlayMarkup;
/**
 * Annotations: where the arrow goes, and how it is drawn.
 *
 * Two halves live here. `deriveAnnotations` decides *what* to mark, from the target rect the
 * recorder measured. The markup/script pair below draws it, and is shared verbatim by the
 * self-contained HTML export and the video template so a guide looks the same in both.
 *
 * The renderer has its own React implementation of the same geometry (it cannot import from
 * electron/). The two are duplicated on purpose; keep them in sync — see
 * src/components/app/views/showcasetool/AnnotatedShot.tsx.
 */
/**
 * Where the number goes on a step that has nothing to point at. A corner, inset far enough
 * that the disc clears the edge at any aspect ratio.
 */
const UNANCHORED_BADGE = { x: 0.042, y: 0.058 };
/**
 * Clearance between the arrow tip and the thing it points at, as a fraction of the width.
 * A highlight ring is drawn *outside* the target rect, so an arrow sharing that target needs
 * more room or its head lands on the ring and reads as poking into the box rather than
 * pointing at it.
 */
const TIP_GAP_BARE = 0.012;
const TIP_GAP_RINGED = 0.032;
const clamp = (value, min = 0.02, max = 0.98) => Math.min(Math.max(value, min), max);
/**
 * Marks for one step, in draw order: highlight underneath, pointer over it, badge on top.
 *
 * A step whose target was never measured gets its number in the corner and nothing else.
 * There used to be a fallback rect in the middle of the shot here, reasoning that the
 * recorder crops to the target padded by 120px so the target is always near the centre. That
 * does not hold for the steps that actually reach it: a `navigate` step has no element, so it
 * is never cropped and its screenshot is the whole viewport — the middle is just whatever the
 * page happened to put there. It boxed an unrelated control and pointed an arrow at it, which
 * reads as a confident instruction to click the wrong thing. Marking nothing is the honest
 * answer, and it matches what those steps say: there is nothing to click.
 */
function deriveAnnotations(target, index, settings, label) {
    if (!settings.enabled)
        return [];
    const color = settings.color;
    const badge = (x, y) => ({ kind: 'badge', x, y, label: String(index + 1), color });
    const rect = usableRect(target);
    if (!rect)
        return settings.numbered ? [badge(UNANCHORED_BADGE.x, UNANCHORED_BADGE.y)] : [];
    const out = [];
    const ringed = settings.style !== 'arrow';
    if (ringed) {
        out.push({ kind: 'box', x: rect.x, y: rect.y, w: rect.width, h: rect.height, color });
    }
    if (settings.style !== 'box') {
        /**
         * Point from whichever side has room. Approaching from the left reads most naturally,
         * but a target hard against the left edge would put the tail off the picture — so the
         * arrow flips rather than being drawn somewhere it cannot be seen.
         */
        const fromLeft = rect.x > 0.28;
        const gap = ringed ? TIP_GAP_RINGED : TIP_GAP_BARE;
        const tipY = clamp(rect.y + rect.height / 2);
        const tip = { x: clamp(fromLeft ? rect.x - gap : rect.x + rect.width + gap), y: tipY };
        const tail = {
            x: clamp(fromLeft ? tip.x - 0.2 : tip.x + 0.2),
            y: clamp(tipY > 0.3 ? tipY - 0.16 : tipY + 0.16),
        };
        out.push({
            kind: 'arrow',
            x: tip.x,
            y: tip.y,
            tailX: tail.x,
            tailY: tail.y,
            color,
            label: settings.callouts ? shorten(label) : undefined,
        });
        if (settings.numbered)
            out.push(badge(tail.x, tail.y));
    }
    else if (settings.numbered) {
        out.push(badge(clamp(rect.x), clamp(rect.y)));
    }
    return out;
}
/** A rect so large it covers the whole shot points at nothing — treat it as no rect at all. */
function usableRect(rect) {
    if (!rect)
        return null;
    if (rect.width >= 0.92 && rect.height >= 0.92)
        return null;
    if (rect.width <= 0 || rect.height <= 0)
        return null;
    return rect;
}
function shorten(label) {
    const clean = label.trim().replace(/\s+/g, ' ');
    return clean.length > 46 ? `${clean.slice(0, 45)}…` : clean;
}
// ------------------------------------------------------------------ rendering
/** The overlay host. Sits inside a `.gt-shot` wrapper next to the `<img>` it annotates. */
function annotationOverlayMarkup(annotations) {
    if (!annotations.length)
        return '';
    return `<span class="gt-ann" data-ann="${escapeAttr(JSON.stringify(annotations))}"></span>`;
}
exports.ANNOTATION_CSS = `
  .gt-shot { position: relative; display: block; line-height: 0; }
  .gt-ann { position: absolute; left: 0; top: 0; pointer-events: none; }
  .gt-ann svg { display: block; overflow: visible; }
`;
/**
 * Draws every overlay once the image it belongs to has real dimensions.
 *
 * The coordinates are fractions of the *image*, but the image is laid out by CSS — it may be
 * letterboxed inside its box by object-fit, which is exactly what happens in a 9:16 video
 * frame. So the content rect is measured here, at layout time, rather than assumed. Re-runs
 * on load and on resize; both exports call `__gtDrawAnnotations()` again after any change.
 */
exports.ANNOTATION_SCRIPT = `<script>(function(){
  function contentRect(img, host){
    var box = img.getBoundingClientRect();
    var origin = host.parentElement.getBoundingClientRect();
    /**
     * getBoundingClientRect reports post-transform pixels, but style.left/top are written in
     * the wrapper's own untransformed coordinates. The video scales the whole wrapper for its
     * push-in, so divide the measurement back out — otherwise the arrow drifts off its target
     * by exactly the zoom factor.
     */
    var scale = img.offsetWidth ? box.width / img.offsetWidth : 1;
    if (!scale || !isFinite(scale)) scale = 1;
    var bw = box.width / scale, bh = box.height / scale;
    var offX = (box.left - origin.left) / scale, offY = (box.top - origin.top) / scale;
    var ar = img.naturalWidth / img.naturalHeight;
    var w = bw, h = bw / ar;
    if (h > bh + 0.5) { h = bh; w = bh * ar; }
    return { left: offX + (bw - w) / 2, top: offY + (bh - h) / 2, width: w, height: h };
  }
  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  /**
   * Ring weight for one highlight. Derived from the target as well as the image: a stroke
   * sized only by the picture swallows a small control — a 32px text input ringed at the
   * image's own scale is more ring than input.
   */
  function ringUnit(u, bw, bh){ return Math.max(1.5, Math.min(u * 0.62, Math.min(bw, bh) * 0.14)); }
  /** True when a numbered disc sits on this point, so a callout can be lifted clear of it. */
  function badgeAt(list, x, y){
    for (var j = 0; j < list.length; j++) {
      var b = list[j];
      if (b.kind === 'badge' && Math.abs(b.x - x) < 0.004 && Math.abs(b.y - y) < 0.004) return true;
    }
    return false;
  }
  function shapes(list, w, h){
    var u = Math.max(2, Math.min(w, h) * 0.011);
    var out = '';
    for (var i = 0; i < list.length; i++) {
      var a = list[i], color = a.color || '#e8453f';
      if (a.kind === 'box') {
        var bw = (a.w || 0) * w, bh = (a.h || 0) * h;
        var ru = ringUnit(u, bw, bh), pad = ru * 1.6;
        var bx = a.x * w - pad, by = a.y * h - pad, rw = bw + pad * 2, rh = bh + pad * 2;
        var r = Math.min(ru * 2.2, rw / 2, rh / 2);
        out += '<rect x="' + bx + '" y="' + by + '" width="' + rw + '" height="' + rh + '" rx="' + r + '"'
             + ' fill="none" stroke="' + esc(color) + '" stroke-opacity="0.25" stroke-width="' + (ru * 3) + '"/>'
             + '<rect x="' + bx + '" y="' + by + '" width="' + rw + '" height="' + rh + '" rx="' + r + '"'
             + ' fill="none" stroke="' + esc(color) + '" stroke-width="' + ru + '"/>';
      } else if (a.kind === 'arrow') {
        var tx = a.x * w, ty = a.y * h;
        var sx = (a.tailX === undefined ? a.x - 0.18 : a.tailX) * w;
        var sy = (a.tailY === undefined ? a.y - 0.14 : a.tailY) * h;
        var dx = tx - sx, dy = ty - sy, len = Math.sqrt(dx * dx + dy * dy) || 1;
        var ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
        var head = Math.min(u * 5, len * 0.5), half = head * 0.52;
        var baseX = tx - ux * head, baseY = ty - uy * head;
        out += '<line x1="' + sx + '" y1="' + sy + '" x2="' + baseX + '" y2="' + baseY + '"'
             + ' stroke="' + esc(color) + '" stroke-width="' + (u * 1.5) + '" stroke-linecap="round"/>'
             + '<polygon points="' + tx + ',' + ty + ' ' + (baseX + nx * half) + ',' + (baseY + ny * half) + ' '
             + (baseX - nx * half) + ',' + (baseY - ny * half) + '" fill="' + esc(color) + '"/>';
        if (a.label) {
          // Clear the numbered disc when one shares this tail, or the two print on top of each other.
          var over = badgeAt(list, a.tailX === undefined ? a.x - 0.18 : a.tailX, a.tailY === undefined ? a.y - 0.14 : a.tailY);
          var fs = u * 2.6, gap = over ? u * 2.9 : u * 1.6;
          /**
           * The callout sits behind the arrow by default, but the tail can be close enough to
           * an edge that the text runs off the picture. No measuring here — an estimate from
           * the glyph count is enough to pick the side that fits.
           */
          var est = String(a.label).length * fs * 0.55;
          var right = ux < 0;
          if (right && sx + gap + est > w - u) right = false;
          else if (!right && sx - gap - est < u) right = true;
          var lx = sx + (right ? gap : -gap);
          var ly = Math.max(fs, sy - (over ? u * 3.4 : u * 1.6));
          out += '<text x="' + lx + '" y="' + ly + '" text-anchor="' + (right ? 'start' : 'end') + '"'
               + ' font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"'
               + ' font-size="' + fs + '" font-weight="650" fill="' + esc(color) + '"'
               + ' paint-order="stroke" stroke="rgba(255,255,255,0.92)" stroke-width="' + (u * 0.9) + '">' + esc(a.label) + '</text>';
        }
      } else if (a.kind === 'badge') {
        // The disc lands on page content, so it carries its own ring — without one the number
        // reads as a smudge over whatever text happens to be underneath it.
        var cx = a.x * w, cy = a.y * h, rad = u * 2.3;
        out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + rad + '" fill="' + esc(color) + '"'
             + ' stroke="#ffffff" stroke-width="' + (rad * 0.18) + '"/>'
             + '<text x="' + cx + '" y="' + (cy + rad * 0.36) + '" text-anchor="middle"'
             + ' font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"'
             + ' font-size="' + (rad * 1.15) + '" font-weight="700" fill="#ffffff">' + esc(a.label || '') + '</text>';
      }
    }
    return out;
  }
  function draw(host){
    var wrap = host.parentElement, img = wrap && wrap.querySelector('img');
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    var rect = contentRect(img, host);
    if (rect.width <= 0 || rect.height <= 0) return;
    var list;
    try { list = JSON.parse(host.getAttribute('data-ann') || '[]'); } catch (e) { return; }
    host.style.left = rect.left + 'px'; host.style.top = rect.top + 'px';
    host.style.width = rect.width + 'px'; host.style.height = rect.height + 'px';
    host.innerHTML = '<svg width="' + rect.width + '" height="' + rect.height + '" viewBox="0 0 ' + rect.width + ' ' + rect.height + '">'
                   + shapes(list, rect.width, rect.height) + '</svg>';
  }
  function all(){ var hosts = document.querySelectorAll('.gt-ann'); for (var i = 0; i < hosts.length; i++) draw(hosts[i]); }
  window.__gtDrawAnnotations = all;
  window.addEventListener('resize', all);
  var imgs = document.images;
  for (var i = 0; i < imgs.length; i++) imgs[i].addEventListener('load', all);
  if (document.readyState === 'complete') all(); else window.addEventListener('load', all);
  all();
})();</script>`;
function escapeAttr(value) {
    return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
//# sourceMappingURL=annotations.js.map