"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.toPptxZip = toPptxZip;
exports.collectPptxImages = collectPptxImages;
exports.speakerNoteLines = speakerNoteLines;
const fs_1 = __importDefault(require("fs"));
const annotationBake_1 = require("./annotationBake");
const ScreenshotStore_1 = require("./ScreenshotStore");
const zipStore_1 = require("./zipStore");
/**
 * PPTX export — one step per slide, speaker notes from the step body.
 *
 * A zip of OOXML, no dependency, the same posture as SCORM. Screenshots are copied (or
 * annotation-baked) into `ppt/media/`; the stored redaction bitmaps are never rewritten.
 */
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
function toPptxZip(guide, images) {
    const slides = guide.steps;
    const entries = [];
    entries.push({ name: '[Content_Types].xml', data: contentTypes(slides, images) });
    entries.push({ name: '_rels/.rels', data: ROOT_RELS });
    entries.push({ name: 'docProps/app.xml', data: appXml(guide, slides.length) });
    entries.push({ name: 'docProps/core.xml', data: coreXml(guide) });
    entries.push({ name: 'ppt/presentation.xml', data: presentationXml(slides.length) });
    entries.push({ name: 'ppt/_rels/presentation.xml.rels', data: presentationRels(slides.length) });
    entries.push({ name: 'ppt/slideMasters/slideMaster1.xml', data: SLIDE_MASTER });
    entries.push({ name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: MASTER_RELS });
    entries.push({ name: 'ppt/slideLayouts/slideLayout1.xml', data: SLIDE_LAYOUT });
    entries.push({ name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: LAYOUT_RELS });
    entries.push({ name: 'ppt/theme/theme1.xml', data: THEME });
    entries.push({ name: 'ppt/notesMasters/notesMaster1.xml', data: NOTES_MASTER });
    entries.push({ name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', data: NOTES_MASTER_RELS });
    slides.forEach((step, i) => {
        const n = i + 1;
        const image = images.get(step.id);
        const imageName = image ? `image${n}.${image.ext}` : null;
        entries.push({ name: `ppt/slides/slide${n}.xml`, data: slideXml(step, n, Boolean(imageName)) });
        entries.push({ name: `ppt/slides/_rels/slide${n}.xml.rels`, data: slideRels(n, imageName) });
        entries.push({ name: `ppt/notesSlides/notesSlide${n}.xml`, data: notesXml(step) });
        entries.push({ name: `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, data: notesRels(n) });
        if (image && imageName)
            entries.push({ name: `ppt/media/${imageName}`, data: image.bytes });
    });
    return (0, zipStore_1.zipBuffers)(entries);
}
async function collectPptxImages(guide) {
    const baked = await (0, annotationBake_1.bakeAnnotatedScreenshots)(guide);
    const out = new Map();
    for (const step of guide.steps) {
        const marked = baked.get(step.id);
        if (marked) {
            out.set(step.id, { bytes: marked, ext: 'png' });
            continue;
        }
        if (!step.screenshot)
            continue;
        const source = ScreenshotStore_1.screenshotStore.absolutePath(step.screenshot);
        if (!fs_1.default.existsSync(source))
            continue;
        try {
            const bytes = fs_1.default.readFileSync(source);
            out.set(step.id, { bytes, ext: sniffExt(bytes) });
        }
        catch {
            /* a missing screenshot becomes a title-only slide */
        }
    }
    return out;
}
function sniffExt(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        return 'jpeg';
    return 'png';
}
function contentTypes(slides, images) {
    const overrides = [
        override('/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'),
        override('/ppt/slideMasters/slideMaster1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml'),
        override('/ppt/slideLayouts/slideLayout1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml'),
        override('/ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'),
        override('/ppt/notesMasters/notesMaster1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml'),
        override('/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'),
        override('/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml'),
    ];
    slides.forEach((step, i) => {
        const n = i + 1;
        overrides.push(override(`/ppt/slides/slide${n}.xml`, 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'));
        overrides.push(override(`/ppt/notesSlides/notesSlide${n}.xml`, 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml'));
        void step;
        void images;
    });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  ${overrides.join('\n  ')}
</Types>
`;
}
function override(part, type) {
    return `<Override PartName="${part}" ContentType="${type}"/>`;
}
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
`;
function presentationRels(count) {
    const slideRels = Array.from({ length: count }, (_, i) => {
        const n = i + 1;
        return `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/>`;
    }).join('\n  ');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${slideRels}
  <Relationship Id="rId${count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  <Relationship Id="rId${count + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
  <Relationship Id="rId${count + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="notesMasters/notesMaster1.xml"/>
</Relationships>
`;
}
function presentationXml(count) {
    const ids = Array.from({ length: count }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId${count + 1}"/></p:sldMasterIdLst>
  <p:notesMasterIdLst><p:notesMasterId r:id="rId${count + 3}"/></p:notesMasterIdLst>
  <p:sldIdLst>${ids}</p:sldIdLst>
  <p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>
`;
}
function slideXml(step, index, hasImage) {
    const title = escapeXml(`${index}. ${step.title}`);
    const image = hasImage
        ? `<p:pic>
      <p:nvPicPr>
        <p:cNvPr id="3" name="Step"/>
        <p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>
        <p:nvPr/>
      </p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
      <p:spPr>
        <a:xfrm><a:off x="457200" y="1371600"/><a:ext cx="11277600" cy="5143500"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      </p:spPr>
    </p:pic>`
        : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="457200" y="274320"/><a:ext cx="11277600" cy="914400"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          <a:p><a:r><a:rPr lang="en-US" sz="2800" b="1"/><a:t>${title}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      ${image}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>
`;
}
function slideRels(n, imageName) {
    const image = imageName
        ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${imageName}"/>`
        : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>
  ${image}
</Relationships>
`;
}
function speakerNoteLines(step) {
    const blocks = [step.body?.trim() || '', step.why?.trim() ? `Why: ${step.why.trim()}` : ''].filter(Boolean);
    const lines = (blocks.length ? blocks : [step.title])
        .flatMap((block) => block.split(/\n+/))
        .map((line) => line.trim())
        .filter(Boolean);
    return lines;
}
function notesXml(step) {
    const paragraphs = speakerNoteLines(step)
        .map((line) => `<a:p><a:r><a:rPr lang="en-US" sz="1400"/><a:t>${escapeXml(line)}</a:t></a:r></a:p>`)
        .join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          ${paragraphs}
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:notes>
`;
}
function notesRels(n) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${n}.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="../notesMasters/notesMaster1.xml"/>
</Relationships>
`;
}
function appXml(guide, slides) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>1ShowcaseTool</Application>
  <Slides>${slides}</Slides>
  <PresentationFormat>Widescreen</PresentationFormat>
  <Company>${escapeXml(guide.branding?.organisation || '')}</Company>
</Properties>
`;
}
function coreXml(guide) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(guide.title)}</dc:title>
  <dc:creator>1ShowcaseTool</dc:creator>
</cp:coreProperties>
`;
}
const SLIDE_MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="0B0E14"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>
`;
const MASTER_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>
`;
const SLIDE_LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">
  <p:cSld name="Blank">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>
`;
const LAYOUT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>
`;
const NOTES_MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notesMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:notesStyle/>
</p:notesMaster>
`;
const NOTES_MASTER_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>
`;
const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="1ShowcaseTool">
  <a:themeElements>
    <a:clrScheme name="1ShowcaseTool">
      <a:dk1><a:srgbClr val="0B0E14"/></a:dk1>
      <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="131A24"/></a:dk2>
      <a:lt2><a:srgbClr val="E6EDF3"/></a:lt2>
      <a:accent1><a:srgbClr val="0B6E96"/></a:accent1>
      <a:accent2><a:srgbClr val="22B8D6"/></a:accent2>
      <a:accent3><a:srgbClr val="3BC46E"/></a:accent3>
      <a:accent4><a:srgbClr val="F5A524"/></a:accent4>
      <a:accent5><a:srgbClr val="E8453F"/></a:accent5>
      <a:accent6><a:srgbClr val="8A94A2"/></a:accent6>
      <a:hlink><a:srgbClr val="0B6E96"/></a:hlink>
      <a:folHlink><a:srgbClr val="0B6E96"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="1ShowcaseTool">
      <a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="1ShowcaseTool">
      <a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
        <a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
        <a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
      <a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>
`;
function escapeXml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
//# sourceMappingURL=pptx.js.map