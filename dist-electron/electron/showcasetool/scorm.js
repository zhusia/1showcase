"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCORM_ADAPTER = exports.SCORM_ADAPTER_MARK = void 0;
exports.toScormHtml = toScormHtml;
exports.imsManifest = imsManifest;
exports.toScormZip = toScormZip;
const exporters_1 = require("./exporters");
const zipStore_1 = require("./zipStore");
/**
 * SCORM 1.2 package: the existing self-contained HTML plus a tiny adapter that talks only
 * to `window.API` — the object the host LMS injects. No fetch, no storage, no beacons.
 *
 * The adapter is *only* in this variant. `verify:core` asserts the plain HTML export is
 * byte-free of it.
 */
exports.SCORM_ADAPTER_MARK = 'gt-scorm-adapter';
exports.SCORM_ADAPTER = `<script id="${exports.SCORM_ADAPTER_MARK}">
(function () {
  // The host LMS injects window.API. This adapter talks only to that object.
  function findAPI(win) {
    var n = 0;
    while (win && n++ < 10) {
      try {
        if (win.API) return win.API;
        if (win.parent === win) return null;
        win = win.parent;
      } catch (e) { return null; }
    }
    return null;
  }
  var api = findAPI(window);
  if (!api) return;
  function call(name, a, b) {
    try { if (typeof api[name] === 'function') api[name](a, b); } catch (e) {}
  }
  call('LMSInitialize', '');
  call('LMSSetValue', 'cmi.core.lesson_status', 'incomplete');
  call('LMSCommit', '');
  window.__gtScormComplete = function (score) {
    if (typeof score === 'number' && isFinite(score)) {
      call('LMSSetValue', 'cmi.core.score.raw', String(Math.round(score)));
    }
    call('LMSSetValue', 'cmi.core.lesson_status', 'completed');
    call('LMSCommit', '');
    call('LMSFinish', '');
  };
  var done = document.getElementById('gt-practice-done');
  if (done) {
    var obs = new MutationObserver(function () {
      if (!done.hidden) window.__gtScormComplete(window.__gtPracticeScore);
    });
    obs.observe(done, { attributes: true, attributeFilter: ['hidden'] });
  }
})();
</script>`;
function toScormHtml(guide, opts = {}) {
    const html = (0, exporters_1.toSelfContainedHtml)(guide, opts);
    if (html.includes('</body>'))
        return html.replace('</body>', `${exports.SCORM_ADAPTER}\n</body>`);
    return `${html}\n${exports.SCORM_ADAPTER}`;
}
function imsManifest(guide) {
    const id = `com.stoicsoft.1showcasetool.${guide.id.replace(/[^a-zA-Z0-9._-]/g, '')}`;
    const title = escapeXml(guide.title);
    return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${id}" version="1.2"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="ORG">
    <organization identifier="ORG">
      <title>${title}</title>
      <item identifier="ITEM" identifierref="RES">
        <title>${title}</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES" type="webcontent" adlcp:scormtype="sco" href="index.html">
      <file href="index.html"/>
    </resource>
  </resources>
</manifest>
`;
}
function toScormZip(guide, opts = {}) {
    return (0, zipStore_1.zipBuffers)([
        { name: 'imsmanifest.xml', data: imsManifest(guide) },
        { name: 'index.html', data: toScormHtml(guide, opts) },
    ]);
}
function escapeXml(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
//# sourceMappingURL=scorm.js.map