"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DOC_TYPE_LABELS = exports.OUTRO_CARD_MS = exports.TITLE_CARD_MS = exports.DEFAULT_CUSTOMIZE = exports.CustomizeSchema = exports.DocTypeSchema = exports.DOC_TYPES = exports.NarrationSettingsSchema = exports.BrandingSettingsSchema = exports.MAX_LOGO_BYTES = exports.VideoSettingsSchema = exports.LanguageSettingsSchema = exports.AnnotationSettingsSchema = void 0;
exports.normalizeCustomize = normalizeCustomize;
exports.videoDimensions = videoDimensions;
exports.videoDurationMs = videoDurationMs;
exports.languageName = languageName;
exports.fontStack = fontStack;
exports.inkOn = inkOn;
exports.activeBranding = activeBranding;
exports.docTypePrompt = docTypePrompt;
const zod_1 = require("zod");
/**
 * The Generation-step customisation settings (§7.3).
 *
 * One object covers the three things a Maker can ask for beyond the prose itself:
 * annotations painted over the step screenshots, extra language versions of the guide, and
 * a rendered video walkthrough. It is persisted per session so re-generating a recording
 * does not mean re-choosing everything.
 *
 * Nothing in here is a secret, so it lives in SQLite with the rest of the session config
 * rather than the vault. Mirrored for the renderer in src/types/app.ts — keep in sync.
 */
const HEX = /^#[0-9a-f]{6}$/i;
exports.AnnotationSettingsSchema = zod_1.z.object({
    enabled: zod_1.z.boolean().default(true),
    /** What gets drawn at the recorded target: a pointer, a highlight ring, or both. */
    style: zod_1.z.enum(['arrow', 'box', 'arrow-box']).default('arrow-box'),
    /**
     * Deliberately *not* the brand cyan. A mark is drawn over a screenshot of someone else's UI,
     * and that UI is overwhelmingly grey, white and blue — a cyan arrow pointing at a cyan button
     * is an arrow nobody sees. This is the palette's warm value, the one reserved for "look here",
     * and it is the same reason every annotation tool ever built lands on red.
     */
    color: zod_1.z.string().regex(HEX).default('#e8453f'),
    /** A numbered disc at the arrow's tail, so a printed guide still reads in order. */
    numbered: zod_1.z.boolean().default(true),
    /** A short text label beside the arrow, taken from the step title. */
    callouts: zod_1.z.boolean().default(false),
});
exports.LanguageSettingsSchema = zod_1.z.object({
    /**
     * BCP-47 codes. The first is the language the guide itself is written in; every other
     * entry produces a sibling guide translated from it.
     */
    codes: zod_1.z.array(zod_1.z.string().min(2).max(12)).min(1).max(12).default(['en']),
});
exports.VideoSettingsSchema = zod_1.z.object({
    enabled: zod_1.z.boolean().default(false),
    /**
     * All three paths are dependency-free. 'mp4' encodes in-app through WebCodecs rather than
     * shelling out to FFmpeg. 'html' is a single self-contained animated file that plays in any
     * browser: the same document the MP4 path screenshots, just left running instead of seeked
     * frame by frame. So this is a format choice, not a fallback for a missing binary.
     *
     * 'apng' is the same captured frames assembled into an animated image (apngEncoder.ts) —
     * the thing you paste into Slack, GitHub or a wiki. It is sampled down to APNG_TARGET_FPS
     * and carries no audio, so narration settings do not apply to it. verify:video renders one
     * and asserts the frames actually differ — the failure mode that kept it unshipped was an
     * animation of identical frames, which every structural check passes.
     */
    format: zod_1.z.enum(['mp4', 'html', 'apng']).default('mp4'),
    aspect: zod_1.z.enum(['16:9', '1:1', '9:16']).default('16:9'),
    resolution: zod_1.z.enum(['720p', '1080p']).default('1080p'),
    fps: zod_1.z.union([zod_1.z.literal(24), zod_1.z.literal(30), zod_1.z.literal(60)]).default(30),
    secondsPerStep: zod_1.z.number().min(1.5).max(12).default(4),
    transition: zod_1.z.enum(['cut', 'fade', 'slide']).default('fade'),
    /**
     * How a still screenshot is kept alive. 'kenburns' is the slow whole-frame push-in.
     * 'cinematic' is the screen-recorder look: the shot becomes a fixed viewport, a camera
     * glides into the step's target, and a drawn cursor arrives and clicks with a ripple.
     * Everything the camera does is derived from the target rect the recorder measured —
     * the same rule as annotations, so it never zooms confidently into an unmeasured spot.
     */
    motion: zod_1.z.enum(['none', 'kenburns', 'cinematic']).default('cinematic'),
    /**
     * Cinematic camera intensity: how close the zoom gets and how the scene's arc is paced.
     * Ignored by the other motion modes, so it can sit here with a default rather than being
     * nested under a mode that may not be selected.
     */
    camera: zod_1.z.enum(['subtle', 'standard', 'close']).default('standard'),
    theme: zod_1.z.enum(['dark', 'light']).default('dark'),
    titleCard: zod_1.z.boolean().default(true),
    /** A closing sign-off card — the keynote "fin". Carries attribution unless whitelabelled. */
    outroCard: zod_1.z.boolean().default(true),
    captions: zod_1.z.boolean().default(true),
    progressBar: zod_1.z.boolean().default(true),
    annotations: zod_1.z.boolean().default(true),
    /** Render immediately after the guide is written, rather than on demand from the guide. */
    renderAfterGenerate: zod_1.z.boolean().default(false),
});
/**
 * Branding (docs/competitor-features.md §2.1). Every competitor sells a branding kit; all of
 * them store it server-side and stamp it at render time on their infrastructure. Ours is a
 * local object stamped by the local exporters, so a branded guide is still one offline file.
 *
 * The logo is a data URI rather than a path on purpose: the HTML export inlines every asset,
 * and a `file://` reference would break the moment the guide is emailed. Bounded so a careless
 * 12 MB PNG cannot make every export unopenable.
 */
exports.MAX_LOGO_BYTES = 512 * 1024;
const DATA_URI = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[a-z0-9+/=]+$/i;
exports.BrandingSettingsSchema = zod_1.z.object({
    enabled: zod_1.z.boolean().default(false),
    /** Shown in the guide header, the PDF, and the video title card. */
    logo: zod_1.z.string().regex(DATA_URI).max(exports.MAX_LOGO_BYTES).optional(),
    /**
     * Drives the step numerals, links, and the video's key colour. Defaults to the brand so an
     * unbranded and a default-branded guide look like the same product; `inkOn()` picks the text
     * that sits on it, so a Maker who types a pale hex still gets a readable numeral.
     */
    accent: zod_1.z.string().regex(HEX).default('#22b8d6'),
    /** Organisation name beside the logo. Falls back to no line at all when empty. */
    organisation: zod_1.z.string().max(80).default(''),
    /**
     * Named stacks only — never a web font. An export that reaches for a font over the network
     * is not a self-contained file, and would leak a request the moment someone opens the guide.
     */
    font: zod_1.z.enum(['system', 'serif', 'mono', 'humanist']).default('system'),
    /** Pro whitelabel. The default keeps the line, and nothing hides the redaction manifest. */
    showAttribution: zod_1.z.boolean().default(true),
});
/**
 * Narration (§2.5). Off by default: a voice track is a strong opinion to put on someone's
 * documentation, and the engine is a platform capability that may not be present.
 */
exports.NarrationSettingsSchema = zod_1.z.object({
    enabled: zod_1.z.boolean().default(false),
    /** Platform voice id. Empty means "whatever the OS considers default". */
    voice: zod_1.z.string().max(120).default(''),
    /** Words per minute, mapped to each platform's own scale by TtsService. */
    wpm: zod_1.z.number().int().min(100).max(300).default(170),
    /**
     * What gets read. 'body' is the instruction alone; 'body-why' adds the reasoning, which
     * roughly doubles the runtime and suits a tutorial more than a runbook.
     */
    script: zod_1.z.enum(['body', 'body-why']).default('body'),
});
/**
 * Guide type (§2.2). Tango ships five separate "creator" products — SOP Creator, Documentation
 * Creator, Employee Handbook Creator, Tutorial Creator — which are one prompt preamble apart
 * from each other. This is that, as a field.
 */
exports.DOC_TYPES = ['guide', 'sop', 'tutorial', 'runbook', 'handbook', 'onboarding'];
exports.DocTypeSchema = zod_1.z.enum(exports.DOC_TYPES).default('guide');
/**
 * prefault, not default: the empty object is fed *through* each sub-schema so its own field
 * defaults fill in. A plain default would have to restate every value here and drift.
 */
exports.CustomizeSchema = zod_1.z.object({
    annotations: exports.AnnotationSettingsSchema.prefault({}),
    languages: exports.LanguageSettingsSchema.prefault({}),
    video: exports.VideoSettingsSchema.prefault({}),
    branding: exports.BrandingSettingsSchema.prefault({}),
    narration: exports.NarrationSettingsSchema.prefault({}),
    docType: exports.DocTypeSchema,
});
exports.DEFAULT_CUSTOMIZE = exports.CustomizeSchema.parse({});
/** Never throws: a stored blob from an older build falls back to defaults field by field. */
function normalizeCustomize(raw) {
    const parsed = exports.CustomizeSchema.safeParse(raw ?? {});
    if (parsed.success)
        return parsed.data;
    return exports.CustomizeSchema.parse({});
}
/**
 * Pixel dimensions for a video preset. Even numbers throughout — yuv420p cannot encode an
 * odd dimension, and every value here is already even so the encoder's scale pad never fires.
 */
function videoDimensions(settings) {
    const small = settings.resolution === '720p';
    switch (settings.aspect) {
        case '1:1':
            return small ? { width: 720, height: 720 } : { width: 1080, height: 1080 };
        case '9:16':
            return small ? { width: 720, height: 1280 } : { width: 1080, height: 1920 };
        case '16:9':
        default:
            return small ? { width: 1280, height: 720 } : { width: 1920, height: 1080 };
    }
}
/** Title card duration, when one is asked for. Long enough to read, short enough to skip. */
exports.TITLE_CARD_MS = 2600;
/** Closing card. Shorter than the title — it is a sign-off, not a second opening. */
exports.OUTRO_CARD_MS = 2400;
function videoDurationMs(settings, stepCount) {
    const steps = Math.max(1, stepCount) * settings.secondsPerStep * 1000;
    return Math.round(steps + (settings.titleCard ? exports.TITLE_CARD_MS : 0) + (settings.outroCard ? exports.OUTRO_CARD_MS : 0));
}
/**
 * Language names for the translation prompt. An unknown code is passed through verbatim —
 * "translate into pt-BR" is a perfectly good instruction even when this table has not heard
 * of it, so a missing entry degrades rather than fails.
 */
const LANGUAGE_NAMES = {
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    it: 'Italian',
    pt: 'Portuguese',
    'pt-BR': 'Brazilian Portuguese',
    nl: 'Dutch',
    pl: 'Polish',
    tr: 'Turkish',
    ru: 'Russian',
    uk: 'Ukrainian',
    ar: 'Arabic',
    hi: 'Hindi',
    id: 'Indonesian',
    vi: 'Vietnamese',
    th: 'Thai',
    ja: 'Japanese',
    ko: 'Korean',
    'zh-Hans': 'Simplified Chinese',
    'zh-Hant': 'Traditional Chinese',
};
function languageName(code) {
    return LANGUAGE_NAMES[code] ?? LANGUAGE_NAMES[code.split('-')[0]] ?? code;
}
/**
 * Font stacks for the exporters and the video template. Every entry is resolvable offline on
 * a stock macOS or Windows install — see the note on BrandingSettingsSchema.font.
 */
const FONT_STACKS = {
    system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    humanist: '"Optima", "Segoe UI", "Gill Sans", Candara, "Trebuchet MS", sans-serif',
    serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif',
    mono: '"SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, Consolas, monospace',
};
function fontStack(branding) {
    return FONT_STACKS[branding.font] ?? FONT_STACKS.system;
}
/**
 * The legible ink for text sitting *on* an accent fill — the step numeral in every export.
 *
 * Every exporter used to hand that numeral `#fff` unconditionally, which is why the HTML export
 * carried a comment naming `#3fd0c9` as 1.7:1 with white and then re-enabled exactly that in its
 * dark block. It is not a fixed answer either, because `branding.accent` is any hex the Maker
 * typed: a pale brand colour needs dark ink and a navy one needs white.
 *
 * WCAG 2.1 relative luminance. 0.19 is where the two candidates cross over — solve
 * `1.05 / (L + 0.05) = (L + 0.05) / 0.0543` and you get L ≈ 0.1888 — so picking the side of it
 * the accent falls on always returns the higher-contrast of the two. At the crossover itself both
 * land near 4.4:1, marginally under AA for small text; that is the ceiling for a two-candidate
 * choice and the numeral is set bold to compensate.
 */
function inkOn(accent) {
    const match = /^#([0-9a-f]{6})$/i.exec(accent.trim());
    if (!match)
        return '#ffffff';
    const packed = parseInt(match[1], 16);
    const channel = (byte) => {
        const unit = byte / 255;
        return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    const luminance = 0.2126 * channel((packed >> 16) & 0xff) + 0.7152 * channel((packed >> 8) & 0xff) + 0.0722 * channel(packed & 0xff);
    return luminance > 0.19 ? '#0b0e14' : '#ffffff';
}
/** Branding only takes effect when switched on — an accent left at default must not leak out. */
function activeBranding(settings) {
    return settings.branding.enabled ? settings.branding : null;
}
/**
 * What each guide type asks the model for. Appended to the generation prompt; it changes the
 * shape of the prose and nothing else — selectors, URLs and placeholders are untouched, so a
 * guide re-generated under a different type is still replayable against the same trace.
 */
const DOC_TYPE_PROMPTS = {
    guide: 'Write this as a step-by-step guide for someone doing the task for the first time. ' +
        'Lead each step with the action.',
    sop: 'Write this as a standard operating procedure. Use precise, repeatable, imperative language. ' +
        'State the purpose and scope up front, name the role responsible where the recording makes it ' +
        'clear, and avoid encouraging or conversational phrasing.',
    tutorial: 'Write this as a teaching tutorial. Explain what each step accomplishes and why it comes in ' +
        'this order, so the reader can adapt the process rather than only repeat it.',
    runbook: 'Write this as an operational runbook for a technical on-call reader. Be terse. Put the ' +
        'expected result and the failure symptom on each step, and skip motivational framing entirely.',
    handbook: 'Write this as a section of an internal employee handbook. Use plain, welcoming language for ' +
        'a non-technical new starter, and expand any jargon visible in the interface on first use.',
    onboarding: 'Write this as a product onboarding walkthrough for a brand-new user of the software being ' +
        'shown. Emphasise what they gain from completing each step, and keep it brief.',
};
function docTypePrompt(docType) {
    return DOC_TYPE_PROMPTS[docType] ?? DOC_TYPE_PROMPTS.guide;
}
/** Display labels for the customise panel. */
exports.DOC_TYPE_LABELS = {
    guide: 'How-to guide',
    sop: 'Standard operating procedure',
    tutorial: 'Tutorial',
    runbook: 'Runbook',
    handbook: 'Employee handbook',
    onboarding: 'Product onboarding',
};
//# sourceMappingURL=customize.js.map