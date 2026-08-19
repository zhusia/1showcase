"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GuideSchema = exports.RedactionManifestSchema = exports.ChapterAssessmentSchema = exports.AssessmentQuestionSchema = exports.GuideStepSchema = exports.BranchSchema = exports.AnnotationSchema = exports.A11yAnchorSchema = exports.VerifySchema = exports.SourceRefSchema = exports.HarvestOutputSchema = exports.SCHEMA_VERSION = void 0;
exports.parseGuide = parseGuide;
exports.isLinked = isLinked;
exports.chaptersOf = chaptersOf;
exports.hasChapters = hasChapters;
exports.hasBranches = hasBranches;
const zod_1 = require("zod");
const customize_1 = require("./customize");
exports.SCHEMA_VERSION = 1;
/**
 * A harvest target addressed in the destination catalog's own vocabulary:
 *   connector:<connector>/<field>
 * Declared by the Maker on the step, never inferred at replay time.
 */
exports.HarvestOutputSchema = zod_1.z
    .strictObject({
    name: zod_1.z.string().min(1),
    selector: zod_1.z.string().min(1),
    target: zod_1.z.string().regex(/^connector:[a-z0-9_-]+\/[a-z0-9_-]+$/i, 'target must be connector:<name>/<field>'),
    sensitive: zod_1.z.boolean().optional().default(false),
})
    /**
     * strictObject is load-bearing, not tidiness. A guide is a shareable artifact, so it
     * must be *structurally* incapable of carrying someone's secret (§7.6). An output
     * declares where a value goes; it can never declare what the value is. A file that
     * smuggles `"value"` in here fails validation instead of being silently stripped.
     */
    .describe('selector + destination mapping only — never a value');
exports.SourceRefSchema = zod_1.z.object({
    path: zod_1.z.string().min(1),
    symbol: zod_1.z.string().optional(),
    reason: zod_1.z.string().optional(),
});
exports.VerifySchema = zod_1.z.discriminatedUnion('kind', [
    zod_1.z.object({ kind: zod_1.z.literal('urlMatches'), value: zod_1.z.string().min(1) }),
    zod_1.z.object({ kind: zod_1.z.literal('selectorPresent'), value: zod_1.z.string().min(1) }),
    zod_1.z.object({ kind: zod_1.z.literal('selectorAbsent'), value: zod_1.z.string().min(1) }),
    zod_1.z.object({ kind: zod_1.z.literal('textPresent'), value: zod_1.z.string().min(1) }),
    zod_1.z.object({ kind: zod_1.z.literal('manual'), value: zod_1.z.string().default('') }),
]);
exports.A11yAnchorSchema = zod_1.z.object({
    role: zod_1.z.string().optional(),
    name: zod_1.z.string().optional(),
    landmark: zod_1.z.string().optional(),
});
/**
 * A mark drawn *over* a step screenshot at render time. Coordinates are normalised 0..1
 * against the image, so the same annotation survives the guide being shown at any size, in
 * the preview, in the HTML export, and in a 9:16 video frame.
 *
 * Deliberately **not** painted into the stored pixels. Redaction destroys pixels and must
 * stay the only thing that does (§7.2) — an arrow that could be baked in would be an arrow
 * that could be moved onto a secret and then "un-drawn" by nobody. Annotations are data;
 * the screenshot underneath is whatever the review pass left behind and never changes.
 *
 * strictObject for the same reason HarvestOutputSchema is: a guide travels, so a mark on it
 * must be structurally incapable of carrying a captured value in some extra key (§7.6).
 */
exports.AnnotationSchema = zod_1.z
    .strictObject({
    kind: zod_1.z.enum(['arrow', 'box', 'badge']),
    /** Arrow tip / box top-left / badge centre, normalised against the screenshot. */
    x: zod_1.z.number().min(-0.25).max(1.25),
    y: zod_1.z.number().min(-0.25).max(1.25),
    /** Box size. Ignored by the other kinds. */
    w: zod_1.z.number().min(0).max(1.5).optional(),
    h: zod_1.z.number().min(0).max(1.5).optional(),
    /** Arrow tail. Absent means "pick a sensible tail from the tip". */
    tailX: zod_1.z.number().min(-0.25).max(1.25).optional(),
    tailY: zod_1.z.number().min(-0.25).max(1.25).optional(),
    /** Callout text, or the number inside a badge. Prose only — never a captured value. */
    label: zod_1.z.string().max(120).optional(),
    color: zod_1.z
        .string()
        .regex(/^#[0-9a-f]{6}$/i)
        .optional(),
})
    .describe('a drawn mark, positioned normalised over the screenshot — never a value');
/**
 * A branch the Follower chooses at the end of a step (docs/competitor-features.md §2.10).
 *
 * `strictObject` for the same reason `HarvestOutputSchema` is: a branch is a *label and a
 * destination*, and a guide must be structurally incapable of carrying anything else. A
 * smuggled `value` key fails validation rather than being quietly stripped.
 *
 * Branches are **declared by the Maker, never authored by the model.** The model writes prose;
 * it does not decide where a reader is sent. A hallucinated branch is the same class of bug as
 * a hallucinated arrow — confidently wrong, and worse here, because it moves someone rather
 * than just mispointing.
 */
exports.BranchSchema = zod_1.z
    .strictObject({
    /** What the Follower is choosing. Shown as the button label. */
    label: zod_1.z.string().min(1).max(80),
    /** The id of the step this choice leads to. Validated against the guide below. */
    goto: zod_1.z.string().min(1),
})
    .describe('a labelled jump to another step — never a value');
exports.GuideStepSchema = zod_1.z.object({
    id: zod_1.z.string().min(1),
    title: zod_1.z.string().min(1),
    body: zod_1.z.string().default(''),
    why: zod_1.z.string().optional(),
    urlPattern: zod_1.z.string().default(''),
    selectors: zod_1.z.array(zod_1.z.string()).default([]),
    a11y: exports.A11yAnchorSchema.default({}),
    screenshot: zod_1.z.string().optional(),
    /** Portable project data lives beside screenshots; exports consume its rendered PNG. */
    annotationProject: zod_1.z.string().optional(),
    annotations: zod_1.z.array(exports.AnnotationSchema).max(16).default([]),
    sourceRefs: zod_1.z.array(exports.SourceRefSchema).optional(),
    verify: exports.VerifySchema.optional(),
    outputs: zod_1.z.array(exports.HarvestOutputSchema).optional(),
    /**
     * Chapter title. Deliberately a string *on the step* rather than a top-level list of
     * chapters holding step ids: consecutive steps sharing a title form a chapter, so there is
     * no cross-reference to keep intact, no way to produce a chapter pointing at a deleted step,
     * and an older build that drops the field simply renders a flat list. Groups are derived,
     * never stored.
     */
    chapter: zod_1.z.string().max(80).optional(),
    /**
     * Where the Follower can go from here instead of the next step. Absent on almost every step —
     * a recording is linear, and branching is something the Maker adds afterwards.
     */
    branches: zod_1.z.array(exports.BranchSchema).max(6).optional(),
    /**
     * Alternate valid controls. Any listed selector is as right as `selectors`. Declared in the
     * review pass, never model-authored — a hallucinated equivalent is a false path.
     */
    altSelectors: zod_1.z.array(zod_1.z.string().min(1).max(240)).max(12).optional(),
    redacted: zod_1.z.boolean().default(false),
});
/**
 * A self-check asked at a chapter end in practice mode. Maker-approved always; model-drafted
 * at most. Offline, nothing persisted.
 */
exports.AssessmentQuestionSchema = zod_1.z.strictObject({
    id: zod_1.z.string().min(1).max(80),
    prompt: zod_1.z.string().min(1).max(240),
    choices: zod_1.z.array(zod_1.z.string().min(1).max(120)).min(2).max(6),
    /** Index into `choices`. The guide carries the answer so practice can score locally. */
    answer: zod_1.z.number().int().min(0).max(5),
});
exports.ChapterAssessmentSchema = zod_1.z.strictObject({
    chapter: zod_1.z.string().min(1).max(80),
    questions: zod_1.z.array(exports.AssessmentQuestionSchema).min(1).max(8),
});
exports.RedactionManifestSchema = zod_1.z.object({
    acknowledgedAt: zod_1.z.string().min(1),
    rules: zod_1.z.array(zod_1.z.string()).default([]),
    placeholders: zod_1.z.array(zod_1.z.string()).default([]),
});
/**
 * SCHEMA_VERSION deliberately stays at 1 as fields are added here.
 *
 * The version exists to stop an older build guessing at a shape it cannot understand. Every
 * field added since v1 — annotations, language, translationOf, video — is optional or
 * defaulted in both directions: an older guide parses here and gains defaults, and a guide
 * written here parses in an older build, which drops the keys it does not know. Bumping
 * would make the previous build refuse files it can in fact read. Bump only when a change
 * is genuinely not backwards-readable.
 */
exports.GuideSchema = zod_1.z.object({
    schemaVersion: zod_1.z.literal(exports.SCHEMA_VERSION),
    id: zod_1.z.string().min(1),
    mode: zod_1.z.enum(['standalone', 'linked']),
    title: zod_1.z.string().min(1),
    intent: zod_1.z.string().default(''),
    audience: zod_1.z.string().default(''),
    /** BCP-47. A translated sibling names the guide it was translated from. */
    language: zod_1.z.string().min(2).max(12).default('en'),
    translationOf: zod_1.z.string().optional(),
    /** Last video preset used for this guide, so re-rendering is one click rather than a form. */
    video: customize_1.VideoSettingsSchema.optional(),
    /**
     * Branding travels *in* the guide, not alongside it. Exports run from the library, by which
     * time the recording session that carried the customise object may be long gone — and a
     * guide handed to someone else has to still render in the Maker's colours.
     */
    branding: customize_1.BrandingSettingsSchema.optional(),
    estimatedMinutes: zod_1.z.number().int().nonnegative().optional(),
    prerequisites: zod_1.z.array(zod_1.z.string()).default([]),
    domains: zod_1.z.array(zod_1.z.string()).default([]),
    sourceCommit: zod_1.z.string().optional(),
    generatedAt: zod_1.z.string().min(1),
    transport: zod_1.z.string().default(''),
    redaction: exports.RedactionManifestSchema,
    steps: zod_1.z.array(exports.GuideStepSchema).min(1),
    /** Optional per-chapter self-check. Absent on almost every guide. */
    assessments: zod_1.z.array(exports.ChapterAssessmentSchema).max(24).optional(),
})
    /**
     * A branch names a step by id, which is the one place this schema has a cross-reference — so
     * it is the one place integrity has to be checked rather than assumed. A goto pointing at a
     * step that does not exist strands the Follower on a dead button, and it is silent: the
     * overlay would simply do nothing when they click.
     *
     * Self-reference is refused too. A step that branches to itself is never what someone meant,
     * and it is the easiest id to get wrong when declaring branches by hand.
     *
     * Cycles between *different* steps are allowed on purpose — "that did not work, go back and
     * try the other option" is a legitimate shape, and every branch needs a human click, so a
     * loop cannot run away.
     */
    .superRefine((guide, ctx) => {
    const ids = new Set(guide.steps.map((step) => step.id));
    guide.steps.forEach((step, index) => {
        step.branches?.forEach((branch, branchIndex) => {
            const path = ['steps', index, 'branches', branchIndex, 'goto'];
            if (!ids.has(branch.goto)) {
                ctx.addIssue({ code: 'custom', path: [...path], message: `branch points at "${branch.goto}", which is not a step in this guide` });
            }
            else if (branch.goto === step.id) {
                ctx.addIssue({ code: 'custom', path: [...path], message: 'a step cannot branch to itself' });
            }
        });
    });
});
/** Validate on load and version on schemaVersion — never trust a guide file's shape. */
function parseGuide(raw) {
    const versioned = zod_1.z.object({ schemaVersion: zod_1.z.number() }).safeParse(raw);
    if (!versioned.success)
        return { ok: false, error: 'not a guide file: missing schemaVersion' };
    if (versioned.data.schemaVersion > exports.SCHEMA_VERSION) {
        return {
            ok: false,
            error: `guide uses schemaVersion ${versioned.data.schemaVersion}; this build understands ${exports.SCHEMA_VERSION}. Update 1ShowcaseTool.`,
        };
    }
    const parsed = exports.GuideSchema.safeParse(raw);
    if (!parsed.success) {
        const first = parsed.error.issues[0];
        const where = first?.path.join('.') || '(root)';
        return { ok: false, error: `invalid guide at ${where}: ${first?.message ?? 'unknown error'}` };
    }
    return { ok: true, guide: parsed.data };
}
/**
 * Linked mode is not a licence check — it is the presence of sourceRefs. Drift
 * detection is impossible without them, which is what makes the value ladder
 * structural (§7.4).
 */
function isLinked(guide) {
    return guide.mode === 'linked' && guide.steps.some((s) => (s.sourceRefs?.length ?? 0) > 0);
}
/**
 * Derive chapters from the steps.
 *
 * Consecutive steps with the same `chapter` form one group; steps with none form an untitled
 * group. Derived rather than stored, so there is no structure to keep in sync with the step
 * list — reorder or delete a step and the chapters are simply whatever the steps now say.
 *
 * Shared by every exporter and the preview, because four implementations of "where does a
 * chapter start" is four chances for them to disagree about the same guide.
 */
function chaptersOf(steps) {
    const out = [];
    steps.forEach((step, index) => {
        const title = step.chapter?.trim() || null;
        const last = out[out.length - 1];
        if (last && last.title === title)
            last.steps.push(step);
        else
            out.push({ title, steps: [step], firstIndex: index });
    });
    return out;
}
/** True when the guide has at least one titled chapter — i.e. grouping is worth rendering. */
function hasChapters(steps) {
    return steps.some((step) => !!step.chapter?.trim());
}
/** True when any step offers a choice, so the reader is not on one fixed path. */
function hasBranches(steps) {
    return steps.some((step) => !!step.branches?.length);
}
//# sourceMappingURL=schema.js.map