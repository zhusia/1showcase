"use strict";
/**
 * The free/Pro matrix — the single place the licence changes what the app does.
 *
 * Deliberately pure and dependency-free: no `electron`, no database, no service singletons, for
 * the same reason `machinePolicy.ts` and `redactionPatterns.ts` are — `verify:core` imports it
 * from `dist-electron/` and exercises it without booting an app. Callers hand in the two facts
 * that matter (is this install Pro, how many guides exist) and get back a decision.
 *
 * The shape of the tier:
 *
 *   FREE   Every recorder, the whole redaction suite, and every exporter. Nothing is blocked.
 *          Guides 1–10 export clean; past that, every export asset carries a watermark.
 *          Customisation is pinned to the defaults: annotation styling, video look presets,
 *          extra languages, and hiding the attribution line are the Pro surface.
 *
 *   PRO    All of it, never watermarked.
 *
 * Charging for redaction would be indefensible — it is the feature that stops someone leaking a
 * credential — so nothing in here can gate it, and `verify:core` asserts that.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRO_CUSTOMIZE_FIELDS = exports.WATERMARK_TEXT = exports.FREE_CLEAN_GUIDES = void 0;
exports.isWatermarked = isWatermarked;
exports.watermarkFor = watermarkFor;
exports.cleanGuidesRemaining = cleanGuidesRemaining;
exports.clampCustomizeToFree = clampCustomizeToFree;
exports.applyEntitlement = applyEntitlement;
exports.applyMusicLicence = applyMusicLicence;
exports.clampStudioMood = clampStudioMood;
exports.applyCaptionLicence = applyCaptionLicence;
exports.clampedFields = clampedFields;
const customize_1 = require("./customize");
const music_1 = require("./music");
/** How many guides a free install can export without a watermark. */
exports.FREE_CLEAN_GUIDES = 10;
/** The mark itself. Short, and the same words the video outro already signs off with. */
exports.WATERMARK_TEXT = 'Made with 1ShowcaseTool';
/** True when this install's exports should carry the watermark. */
function isWatermarked(facts) {
    if (facts.pro)
        return false;
    return facts.guideCount > exports.FREE_CLEAN_GUIDES;
}
/** The watermark string for an export, or null when the export should be clean. */
function watermarkFor(facts) {
    return isWatermarked(facts) ? exports.WATERMARK_TEXT : null;
}
/** How many clean guides a free install has left. Null on Pro, where there is no quota. */
function cleanGuidesRemaining(facts) {
    if (facts.pro)
        return null;
    return Math.max(0, exports.FREE_CLEAN_GUIDES - facts.guideCount);
}
/**
 * The customisation fields Pro unlocks. Named rather than inferred, so the Settings copy, the
 * Customize panel and `verify:core` can all read the same list instead of three drifting ones.
 */
exports.PRO_CUSTOMIZE_FIELDS = [
    'annotation styling',
    'video look presets',
    'extra languages',
    'hiding the attribution line',
];
/**
 * Clamp a customisation object to what a free install may ask for.
 *
 * Clamping rather than refusing is the point: a free Maker who opens the panel, picks a colour and
 * presses Generate gets a guide, not an error — they simply get the default colour, and the panel
 * says so. Refusing here would turn a Pro upsell into a broken button.
 *
 * What survives untouched on free: whether annotations are on at all, whether a video is rendered
 * and in which format, the document type, branding logo/accent/organisation, and narration. Those
 * are choices about *what* to make; the clamped fields are choices about how it looks.
 */
function clampCustomizeToFree(settings) {
    const d = customize_1.DEFAULT_CUSTOMIZE;
    return {
        ...settings,
        annotations: {
            ...settings.annotations,
            style: d.annotations.style,
            color: d.annotations.color,
            numbered: d.annotations.numbered,
            callouts: d.annotations.callouts,
        },
        languages: {
            // The first code is the language the guide is written in, which is not a Pro decision.
            codes: settings.languages.codes.slice(0, 1),
        },
        video: {
            ...settings.video,
            aspect: d.video.aspect,
            resolution: d.video.resolution,
            fps: d.video.fps,
            secondsPerStep: d.video.secondsPerStep,
            transition: d.video.transition,
            motion: d.video.motion,
            camera: d.video.camera,
            theme: d.video.theme,
            titleCard: d.video.titleCard,
            outroCard: d.video.outroCard,
            captions: d.video.captions,
            progressBar: d.video.progressBar,
        },
        branding: {
            ...settings.branding,
            /**
             * Whitelabel hides *our* name and nothing else — it has never been able to hide the
             * redaction manifest, and it still cannot. On free the line simply stays.
             */
            showAttribution: true,
        },
    };
}
/** Apply the licence to a customisation object. Pro passes through untouched. */
function applyEntitlement(settings, pro) {
    return pro ? settings : clampCustomizeToFree(settings);
}
/**
 * Studio music: the engine is free, the AI composer and the `epic` / `night` moods are Pro.
 * Clamped, never refused — a free Maker who picks `epic` still gets a score.
 */
function applyMusicLicence(music, pro) {
    return (0, music_1.applyMusicEntitlement)(music, pro);
}
function clampStudioMood(mood, pro) {
    return (0, music_1.clampMusicMood)(mood, pro);
}
/**
 * Caption styling is Pro; captions themselves are free. Clamp-don't-refuse.
 *
 * Everything here is *how the words look* — treatment, typeface, size, colour, plate and case. What
 * they say, when they say it and both sidecar formats are free, because a caption is an
 * accessibility surface before it is a brand one and gating legibility would be the same mistake as
 * gating redaction. The clamp is written field by field rather than by replacing the object, so a
 * transcript can never be lost to a licence check.
 */
function applyCaptionLicence(captions, pro) {
    if (pro)
        return captions;
    return { ...captions, style: 'clean', highlight: '', font: 'system', size: 100, color: '', plate: 'pill', uppercase: false };
}
/**
 * Which fields a free install would have had clamped — for the panel's "Pro" hints, so it can mark
 * the exact controls that will not take effect rather than shrugging at the whole card.
 */
function clampedFields(settings) {
    const clamped = clampCustomizeToFree(settings);
    const changed = [];
    if (JSON.stringify(clamped.annotations) !== JSON.stringify(settings.annotations))
        changed.push('annotations');
    if (clamped.languages.codes.length !== settings.languages.codes.length)
        changed.push('languages');
    if (JSON.stringify(clamped.video) !== JSON.stringify(settings.video))
        changed.push('video');
    if (clamped.branding.showAttribution !== settings.branding.showAttribution)
        changed.push('branding');
    return changed;
}
//# sourceMappingURL=entitlements.js.map