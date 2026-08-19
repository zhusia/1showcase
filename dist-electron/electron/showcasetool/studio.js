"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_STUDIO = exports.StudioProjectSchema = exports.StudioClipSchema = exports.StudioClipLookSchema = exports.StudioExportSchema = exports.EXPORT_ASPECTS = exports.StudioRhythmSchema = exports.StudioSceneSchema = exports.StudioFinishSchema = exports.LIGHTING_IDS = exports.StudioAudioSchema = exports.StudioClickSoundSchema = exports.CLICK_SOUNDS = exports.StudioWebcamSchema = exports.WEBCAM_ANCHORS = exports.WEBCAM_SHAPES = exports.StudioCaptionsSchema = exports.StudioCaptionCardSchema = exports.CAPTION_PLATES = exports.CAPTION_FONTS = exports.CAPTION_STYLES = exports.StudioCaptionWordSchema = exports.StudioCutSchema = exports.CUT_GESTURES = exports.StudioBRollSchema = exports.StudioBRollGapSchema = exports.BROLL_KINDS = exports.StudioKeystrokeDisplaySchema = exports.StudioKeystrokeSchema = exports.StudioMarkerSchema = exports.StudioGradeSchema = exports.SCENE_STYLES = exports.DEVICE_KINDS = exports.StudioPoseSchema = exports.StudioZoomSchema = exports.StudioCursorSchema = exports.CURSOR_STYLES = exports.CURSOR_RETIMINGS = exports.StudioBackgroundSchema = exports.ZoomKeyframeSchema = exports.StudioMaskSchema = void 0;
exports.inspectStudio = inspectStudio;
exports.normalizeStudio = normalizeStudio;
exports.parseStudioStrict = parseStudioStrict;
exports.studioExportRefusal = studioExportRefusal;
exports.studioEditAffectsOutput = studioEditAffectsOutput;
const zod_1 = require("zod");
const music_1 = require("./music");
/**
 * The studio recording project: what the Maker recorded, and everything they can change about
 * it afterwards without touching the footage.
 *
 * The captured movie is never edited in place. Trim, speed, zoom, cursor treatment, background
 * and masks are all *description* — they are applied when a take is rendered, so every edit is
 * reversible and the raw capture stays exactly as ScreenCaptureKit wrote it. The one exception
 * is deliberate and one-way: at export the mask rectangles are filled with opaque pixels into
 * the frames being encoded, and there is no unredact (see §7.2 and `burnMasks`).
 *
 * **Deliberately free of any `electron` import.** Everything here is pure schema and predicate
 * logic, which is what lets `verify:core` import it from `dist-electron/` and check the safety
 * rules without booting an app — the same reason `machinePolicy.ts` stays importable.
 *
 * ## What is here and what is not
 *
 * This file holds the *persisted shape* and the *export gate*, and nothing else. The motion
 * itself — cursor smoothing, the automatic camera, where a mask lands once the zoom has moved —
 * lives in `src/lib/studio.ts`, because both things that consume it run in the renderer: the
 * editor's live preview and the exporter's frame loop. Putting the maths here would mean a
 * second copy over in `src/`, and the two drifting is exactly the bug the annotation geometry
 * already has to be hand-managed against. One consumer, one copy.
 */
// ---------------------------------------------------------------- primitives
/**
 * A normalised rectangle over the capture.
 *
 * Two different failures, treated differently on purpose. A rectangle that merely *hangs off* the
 * capture is repaired by clipping — that can only ever remove area which shows nothing, so it is
 * safe to do silently. A rectangle that is non-finite, has no extent, or ends up entirely outside
 * the frame is not repairable, and is **refused** so it lands in quarantine (§7.3) rather than
 * being quietly dropped: a mask that vanishes is a region that is silently no longer redacted.
 *
 * Before M0c this accepted negative extents and coordinates outside 0..1, which a destructive
 * primitive should never have allowed.
 */
const RectSchema = zod_1.z
    .object({
    x: zod_1.z.number().finite(),
    y: zod_1.z.number().finite(),
    width: zod_1.z.number().finite().gt(0),
    height: zod_1.z.number().finite().gt(0),
})
    .transform((rect) => {
    const x = Math.max(0, Math.min(1, rect.x));
    const y = Math.max(0, Math.min(1, rect.y));
    const right = Math.max(0, Math.min(1, rect.x + rect.width));
    const bottom = Math.max(0, Math.min(1, rect.y + rect.height));
    return { x, y, width: right - x, height: bottom - y };
})
    .refine((rect) => rect.width > 0 && rect.height > 0, {
    message: 'the rectangle does not overlap the capture',
});
/**
 * A destructive mask. Rectangles are normalised to the captured frame so they survive any
 * export resolution, and `fromMs`/`toMs` let a Maker cover something that is only on screen
 * for part of the take rather than blanking the whole recording.
 *
 * `toMs` of null means "to the end". A mask with no time bounds covers everything, which is
 * the safe default for a box drawn without thinking about time.
 */
exports.StudioMaskSchema = zod_1.z.object({
    id: zod_1.z.string().min(1),
    rect: RectSchema,
    fromMs: zod_1.z.number().min(0).default(0),
    toMs: zod_1.z.number().min(0).nullable().default(null),
    /** What the Maker said this covers. Shown in the redaction manifest, never the value itself. */
    label: zod_1.z.string().max(120).default(''),
});
/**
 * One point on the zoom timeline. `scale` is a magnification of the captured frame and `x`/`y`
 * are the normalised point held at the centre of the viewport.
 */
exports.ZoomKeyframeSchema = zod_1.z.object({
    atMs: zod_1.z.number().min(0),
    scale: zod_1.z.number().min(1).max(6).default(1),
    x: zod_1.z.number().min(0).max(1).default(0.5),
    y: zod_1.z.number().min(0).max(1).default(0.5),
});
// ---------------------------------------------------------------- settings
/**
 * The frame the recording sits inside. This is the single most recognisable thing a modern
 * screen-recording tool does: a raw desktop capture looks like a support ticket attachment, and
 * the same footage inset on a coloured field with a rounded corner and a shadow reads as a
 * product demo. It costs nothing at capture time because it is composited at render time.
 */
exports.StudioBackgroundSchema = zod_1.z.object({
    /** 'none' renders the capture edge to edge, which is what a screencast for docs wants. */
    kind: zod_1.z.enum(['none', 'solid', 'gradient', 'wallpaper']).default('gradient'),
    preset: zod_1.z.string().max(40).default('aperture'),
    /**
     * Which shipped wallpaper `kind: 'wallpaper'` draws — an **id into the bundled set**, never a
     * path and never image bytes.
     *
     * An id keeps this column the size it always was, keeps the project file portable between
     * machines, and — the reason that actually matters — keeps a background out of the class of
     * things a Maker can point at arbitrary bytes. A path would be a file the renderer has to be
     * allowed to read; bytes would be a second megabyte-scale blob inside a row the editor rewrites
     * every 400 ms. An id the renderer cannot resolve draws nothing and refuses the export, which is
     * the same posture the rest of this file takes: stop rather than ship a different picture.
     *
     * Kept beside `preset` rather than replacing it so switching gradient → image → gradient gives
     * the Maker back the pair they had chosen, instead of resetting one of them each way.
     */
    wallpaper: zod_1.z.string().max(40).default('neon-city'),
    /**
     * How far the wallpaper is pushed behind the picture, as a percentage of the way to black.
     *
     * A photograph is a busier ground than a gradient, and the capture has to stay the brightest
     * thing in the frame. Applied to the image only — a gradient preset is already tuned.
     */
    dim: zod_1.z.number().min(0).max(100).default(28),
    color: zod_1.z.string().max(32).default('#0b0e14'),
    /** Percent of the *smaller* output edge left as margin around the capture. */
    padding: zod_1.z.number().min(0).max(25).default(6),
    /** Corner radius in output pixels at 1080p, scaled with the frame. */
    radius: zod_1.z.number().min(0).max(64).default(14),
    shadow: zod_1.z.number().min(0).max(100).default(55),
});
/**
 * How the pointer is drawn.
 *
 * It is re-rendered rather than captured: `showsCursor` is false on the stream, so the only
 * pointer in the output is this one. That is what makes it possible to smooth the path, scale
 * the pointer independently of the zoom, and put a ripple under a click — none of which can be
 * done to a cursor that is already baked into the pixels.
 */
exports.CURSOR_RETIMINGS = ['off', 'natural', 'cinematic'];
/**
 * How the pointer is drawn. `arrow` and `hand` are paths; the rest are ids into the shipped
 * sprite set in `src/lib/studioCursors.ts`. The default stays the drawn arrow so a project
 * that never picked a skin still looks like this product made it.
 */
exports.CURSOR_STYLES = [
    'arrow',
    'hand',
    'banana',
    'cat',
    'dog',
    'paw',
    'chick',
    'gold',
    'capybara',
    'fish',
    'bird',
    'snail',
    'dolphin',
    'frog',
    'penguin',
    'panda',
];
exports.StudioCursorSchema = zod_1.z.object({
    enabled: zod_1.z.boolean().default(true),
    /** 0 is the raw 60 Hz track; 1 is heavily damped. Removes hand tremor, keeps intent. */
    smoothing: zod_1.z.number().min(0).max(1).default(0.55),
    /**
     * How the path is re-timed between clicks. `off` is today's bidirectional filter. The other
     * two are closed-form splines through the recorded samples, and they never move a click:
     * the path is rewritten *between* the anchors, which stay where the Maker actually pressed.
     * Off by default so a documentary take is the recording it was.
     */
    retiming: zod_1.z.enum(exports.CURSOR_RETIMINGS).default('off'),
    /** Which pointer is drawn. An id, never a path and never bytes. */
    style: zod_1.z.enum(exports.CURSOR_STYLES).default('arrow'),
    /** Multiplier on the drawn pointer, applied *after* the zoom so it never becomes a monolith. */
    size: zod_1.z.number().min(0.5).max(3).default(1.25),
    /** An expanding ring at each click, so a silent recording still shows where the action was. */
    clickHighlight: zod_1.z.boolean().default(true),
    /**
     * The warm value, not the brand — a ripple over arbitrary footage has to be seen, and the
     * footage is frequently of a cyan-ish UI. Same reasoning as the annotation mark.
     */
    clickColor: zod_1.z.string().max(32).default('#e8453f'),
    /** Fade the pointer when it has not moved, so an idle take does not keep a stuck arrow on screen. */
    idleFade: zod_1.z.boolean().default(false),
});
exports.StudioZoomSchema = zod_1.z.object({
    /** Derive the zoom timeline from the click track. Off leaves only manual keyframes. */
    auto: zod_1.z.boolean().default(true),
    /**
     * When two clicks sit inside 800 ms, hold the zoom 250 ms longer so the viewer can catch up.
     * Cosmetic: it does not change which source instants ship.
     */
    autoPause: zod_1.z.boolean().default(true),
    /** How far in an automatic zoom goes. */
    scale: zod_1.z.number().min(1).max(4).default(1.8),
    /** Time spent travelling in and out of a zoom. */
    inMs: zod_1.z.number().min(120).max(3000).default(650),
    outMs: zod_1.z.number().min(120).max(3000).default(750),
    /** How long the zoom is held after the last click of a cluster. */
    holdMs: zod_1.z.number().min(200).max(8000).default(1400),
    /**
     * Keyframes the Maker added or edited. When `auto` is on these are merged over the derived
     * ones, so hand-tuning one moment does not mean hand-tuning all of them.
     */
    keyframes: zod_1.z.array(exports.ZoomKeyframeSchema).max(400).default([]),
});
/**
 * Where the device sits, and how it is turned.
 *
 * Angles in degrees, position as a fraction of the output, `scale` as a dolly where 1 is the
 * framing a flat scene would have given. The schema holds the Maker's rest pose, including
 * back-facing angles; readability over content is the director's job, not a range the data
 * model forbids. Roll stays a spice.
 */
exports.StudioPoseSchema = zod_1.z.object({
    scale: zod_1.z.number().finite().min(0.2).max(3).default(1),
    x: zod_1.z.number().finite().min(-1).max(2).default(0.5),
    y: zod_1.z.number().finite().min(-1).max(2).default(0.5),
    yaw: zod_1.z.number().finite().min(-180).max(180).default(0),
    pitch: zod_1.z.number().finite().min(-30).max(85).default(0),
    roll: zod_1.z.number().finite().min(-15).max(15).default(0),
});
exports.DEVICE_KINDS = ['macbook', 'macbook-air', 'display', 'browser', 'window', 'phone', 'tablet'];
/**
 * The three films a client actually asks for, as one word each.
 *
 * A preset is a *table of numbers over one motion system*, never a second code path — which is why
 * adding a fourth genre later costs a row in `STYLES` in `studioDirector.ts` and nothing here.
 * `showcase` is the default because a Maker who changes nothing should get the film this feature
 * exists to make; a Maker who wants the previous behaviour sets `motion: 'still'`, which is
 * untouched and always will be.
 */
exports.SCENE_STYLES = ['showcase', 'documentary', 'kinetic'];
/**
 * The grade: light, depth and the finish.
 *
 * Every entry is a *wish*, not an effect — the style gates it (documentary refuses parallax and the
 * shutter outright) and `resolveGrade` in `studioDirector.ts` is the single place the two are
 * combined. Splitting it that way is what keeps a style a table of numbers: turning documentary on
 * must not silently rewrite the Maker's toggles, and turning it off again must give them back.
 *
 * Not in `studioEditAffectsOutput`, and the argument is the same one the pose already makes: a
 * grade rearranges pixels that were reviewed and cannot reveal a texel a capture-space mask
 * destroyed, because the burn happens before anything here samples the frame.
 */
exports.StudioGradeSchema = zod_1.z.object({
    /** A device turning away sheds highlight. Intensity only — the direction of the light is fixed. */
    glareTracksCamera: zod_1.z.boolean().default(true),
    /** One 700 ms diagonal sweep when a cut changes the device, so a swap reads as a reveal. */
    sweepOnArrival: zod_1.z.boolean().default(true),
    /** The background moves against the device. The cheapest depth cue there is. */
    parallax: zod_1.z.boolean().default(true),
    /** Corner darkening, as a percentage. Capped at 10: a vignette anyone notices is a vignette. */
    vignette: zod_1.z.number().min(0).max(10).default(6),
    /**
     * Synthetic directional smear on frames the camera is moving too fast for anyone to read.
     *
     * Redaction-safe by construction: it runs *after* the burn and after the composite, on pixels
     * that are already allowed to ship, sampled from one source instant. No temporal lookaround, and
     * a still frame skips the pass entirely — which is what `verify:video`'s held-frame fixture pins.
     */
    shutter: zod_1.z.boolean().default(true),
    /** 2.35:1 bars, drawn rather than cropped — nothing of the Maker's picture is discarded. */
    letterbox: zod_1.z.boolean().default(false),
});
/**
 * The Maker's shot intent: *something happens here*.
 *
 * A marker is deliberately **not** a shot (§6.4). The director compiles the best move that survives
 * the composed feasibility check, so changing the style or pulling the intensity down re-derives
 * every marker instead of leaving half the film frozen at the old setting.
 *
 * Two things about the anchor are load-bearing. `clipId` names a clip *instance*, and `sourceMs` is
 * an **absolute** source instant rather than an offset into that clip — an offset is only stable
 * while `sourceStartMs` never moves, and dragging a clip's in-point would silently relocate the
 * marker onto different footage. And `choiceId` is a stable move key, never an index into the
 * candidate list: the list is contextual, so an index means a clip reorder can hand a locked marker
 * a different angle while it is displaying a padlock.
 */
exports.StudioMarkerSchema = zod_1.z.object({
    id: zod_1.z.string().min(1).max(120),
    clipId: zod_1.z.string().min(1).max(120),
    sourceMs: zod_1.z.number().finite().min(0),
    choiceId: zod_1.z.string().max(60).default(''),
    locked: zod_1.z.boolean().default(false),
    label: zod_1.z.string().max(120).default(''),
});
/**
 * A keyboard action authored in the editor at one moment of one clip instance.
 *
 * The model deliberately has no free-form captured value. `label` describes a type action;
 * shortcuts carry only their display keys. Both are bounded because the renderer writes this
 * object across IPC on every autosave.
 */
const StudioKeystrokeAnchor = {
    id: zod_1.z.string().min(1).max(120),
    clipId: zod_1.z.string().min(1).max(120),
    sourceMs: zod_1.z.number().finite().min(0),
};
exports.StudioKeystrokeSchema = zod_1.z.discriminatedUnion('kind', [
    zod_1.z.strictObject({
        ...StudioKeystrokeAnchor,
        kind: zod_1.z.literal('shortcut'),
        keys: zod_1.z.array(zod_1.z.string().min(1).max(24).regex(/^[^\u0000-\u001f\u007f]+$/)).min(1).max(5),
    }),
    zod_1.z.strictObject({
        ...StudioKeystrokeAnchor,
        kind: zod_1.z.literal('type'),
        label: zod_1.z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/),
    }),
]);
/** Presentation preferences for the overlay `drawFrame` draws on the preview and the export. */
exports.StudioKeystrokeDisplaySchema = zod_1.z.object({
    enabled: zod_1.z.boolean().default(true),
    labelSize: zod_1.z.number().finite().min(60).max(180).default(100),
    showSingleKeyShortcuts: zod_1.z.boolean().default(false),
});
/**
 * The b-roll vocabulary: the cutaway interludes the camera may play when a new clip arrives.
 *
 * Film b-roll is second-camera footage cut in over the story. This studio has one camera and one
 * recording, so its b-roll is the honest equivalent: **camera language played over the head of the
 * clip a cut lands on** — film cutaways (establishing, close-up, arc, light, insert) and explicit
 * camera moves (pan, tilt, orbit, zoom). Nothing is inserted into the timeline: the runtime does
 * not change, the audio stays in sync, and no source instant ships that was not already shipping.
 * Archival/stock footage is deliberately not a kind — nothing that was not recorded on this
 * machine enters a film.
 *
 * Deliberately **not** in `studioEditAffectsOutput`, by the same argument the pose and the grade
 * make: an interlude rearranges pixels the Maker already reviewed and cannot sample a texel the
 * burn destroyed, because the burn happens in capture space before any of this touches a frame.
 *
 * Keep in sync with `StudioBRollKind` in `src/types/app.ts` and `BROLL_BOOK` in `studioDirector.ts`.
 */
exports.BROLL_KINDS = [
    'establishing',
    'action',
    'narrative',
    'lighting',
    'insert',
    'pan-horizontal',
    'pan-vertical',
    'orbit',
    'spiral-up',
    'tilt-up',
    'top-down',
    'profile-pass',
    'zoom-in',
    'zoom-out',
    /**
     * The **angles**: a cut away to a named camera position, held, and returned from — the
     * second-camera setups a product film actually uses. Unlike the moves above, an angle is a
     * *destination framing* rather than a gesture, so the director lands it on an absolute pose
     * instead of a delta from wherever the shot happened to be resting.
     *
     * `camera-from-back` stays the steep shoulder-side silhouette so films that already picked it
     * do not jump; full orbits and the profile pass are the new verbs that walk around the mesh.
     */
    'camera-from-back',
    'typing',
    'direct-typing',
    'left-angle',
    'above',
    'screen-dolly',
    'edge-rake',
    'hinge-profile',
    'crane-rise',
    'slow-reveal',
];
/**
 * One cut's b-roll pick. Keyed by the *destination* clip — the interlude opens on the head of the
 * clip the cut lands on, so Clip 1→2 is stored under clip 2's id. Reordering keeps the assignment
 * with that clip (same contract as markers); a split that mints a new id falls back to the
 * rotation until the Maker picks again.
 */
exports.StudioBRollGapSchema = zod_1.z.object({
    clipId: zod_1.z.string().min(1).max(120),
    /**
     * Which language to play. Empty string is a gap-level mute: this cut has no interlude while
     * others still can. Distinct from turning b-roll off for the whole take.
     */
    kind: zod_1.z.union([zod_1.z.enum(exports.BROLL_KINDS), zod_1.z.literal('')]).default(''),
});
exports.StudioBRollSchema = zod_1.z.object({
    enabled: zod_1.z.boolean().default(false),
    /**
     * Fallback rotation for cuts that have no `gaps` row yet (a fresh split, an unedited take).
     * All of it until the Maker narrows it. An explicit gap always wins.
     */
    kinds: zod_1.z.array(zod_1.z.enum(exports.BROLL_KINDS)).max(exports.BROLL_KINDS.length).default([...exports.BROLL_KINDS]),
    /** How long one interlude runs, capped by the director to fit inside its shot. */
    lengthMs: zod_1.z.number().min(800).max(4000).default(1800),
    /** Per-cut picks. At most one row per destination clip. */
    gaps: zod_1.z.array(exports.StudioBRollGapSchema).max(200).default([]),
});
/**
 * A gesture assigned to a particular cut. Same honesty machinery as move markers: compiled /
 * reduced / yielded, reasons printed. Style-gated like the grade — documentary refuses whip.
 *
 * Keyed by the *destination* clip, same as b-roll: Clip 1→2 lives under clip 2's id.
 */
exports.CUT_GESTURES = ['carried', 'whip', 'reveal', 'hold'];
exports.StudioCutSchema = zod_1.z.object({
    clipId: zod_1.z.string().min(1).max(120),
    gesture: zod_1.z.union([zod_1.z.enum(exports.CUT_GESTURES), zod_1.z.literal('')]).default(''),
    locked: zod_1.z.boolean().default(false),
});
/**
 * One word of an on-device transcript. Times are on the *recorded* clock, so a trim or a
 * clip reorder carries the words with the footage rather than leaving them pinned to an
 * edit they no longer describe.
 */
exports.StudioCaptionWordSchema = zod_1.z.object({
    word: zod_1.z.string().min(1).max(80),
    tMs: zod_1.z.number().finite().min(0),
    dMs: zod_1.z.number().finite().min(0).max(8_000),
});
exports.CAPTION_STYLES = ['clean', 'bold', 'karaoke'];
/**
 * The typeface and the plate behind it.
 *
 * A font is an **id** into a bundled stack table (`captionFontStack` in `src/lib/studioCaptions.ts`),
 * never a family name the Maker typed — the same argument the wallpapers make. A family name that
 * happens to be installed here would silently fall back to something else on the machine that opens
 * the take, and a caption is the one layer whose whole job is to be read.
 *
 * Keep in sync with `StudioCaptionFont` / `StudioCaptionPlate` in `src/types/app.ts`.
 */
exports.CAPTION_FONTS = ['system', 'rounded', 'serif', 'mono', 'condensed'];
exports.CAPTION_PLATES = ['pill', 'block', 'none'];
exports.StudioCaptionCardSchema = zod_1.z.object({
    id: zod_1.z.string().min(1).max(80),
    atMs: zod_1.z.number().finite().min(0),
    durationMs: zod_1.z.number().finite().min(200).max(8000).default(2000),
    text: zod_1.z.string().min(1).max(200),
    kind: zod_1.z.enum(['chapter', 'callout']).default('chapter'),
});
exports.StudioCaptionsSchema = zod_1.z.object({
    enabled: zod_1.z.boolean().default(false),
    words: zod_1.z.array(exports.StudioCaptionWordSchema).max(20_000).default([]),
    style: zod_1.z.enum(exports.CAPTION_STYLES).default('karaoke'),
    position: zod_1.z.enum(['bottom', 'top']).default('bottom'),
    /** Empty means the brand accent. Pro can restyle; free is clamped to the default. */
    highlight: zod_1.z.string().max(32).default(''),
    /** Typeface, size, word colour and plate. Styling, so the same Pro clamp as `style` covers it. */
    font: zod_1.z.enum(exports.CAPTION_FONTS).default('system'),
    size: zod_1.z.number().finite().min(60).max(180).default(100),
    color: zod_1.z.string().max(32).default(''),
    plate: zod_1.z.enum(exports.CAPTION_PLATES).default('pill'),
    uppercase: zod_1.z.boolean().default(false),
    lowerThird: zod_1.z
        .object({
        enabled: zod_1.z.boolean().default(false),
        text: zod_1.z.string().max(80).default(''),
    })
        .prefault({}),
    /** Overlay cards (chapter titles, why-callouts). They insert no time and change no audio. */
    cards: zod_1.z.array(exports.StudioCaptionCardSchema).max(80).default([]),
});
/**
 * Where the talking-head sits. A separate track, never baked into the screen pixels — layout
 * is a post-hoc decision, exactly like everything else in the studio.
 *
 * Changes that alter *which camera pixels ship* belong in `studioEditAffectsOutput`.
 */
exports.WEBCAM_SHAPES = ['circle', 'rounded'];
exports.WEBCAM_ANCHORS = [
    'bottom-right',
    'bottom-left',
    'top-right',
    'top-left',
    'side-left',
    'side-right',
    'full',
];
exports.StudioWebcamSchema = zod_1.z.object({
    enabled: zod_1.z.boolean().default(false),
    shape: zod_1.z.enum(exports.WEBCAM_SHAPES).default('rounded'),
    anchor: zod_1.z.enum(exports.WEBCAM_ANCHORS).default('bottom-right'),
    /** Fraction of the shorter output edge. Ignored for `full`. */
    size: zod_1.z.number().min(0.12).max(1).default(0.22),
});
/**
 * Loudness and a gentle gate. Spectral noise reduction is deliberately absent — the panel
 * does not pretend we ship one.
 */
exports.CLICK_SOUNDS = ['tick', 'pop', 'mechanical', 'none'];
exports.StudioClickSoundSchema = zod_1.z.object({
    enabled: zod_1.z.boolean().default(false),
    sound: zod_1.z.enum(exports.CLICK_SOUNDS).default('tick'),
    volume: zod_1.z.number().min(0).max(100).default(40),
});
exports.StudioAudioSchema = zod_1.z.object({
    /** Exclude the recorded sound from preview and export. The source files remain untouched. */
    muted: zod_1.z.boolean().default(false),
    normalize: zod_1.z.boolean().default(false),
    /** Speech target. −16 LUFS is the broadcast-speech convention this product quotes. */
    targetLufs: zod_1.z.number().min(-24).max(-10).default(-16),
    noiseGate: zod_1.z.boolean().default(false),
    /**
     * High-pass, light compression and a soft gate on the speech lane. The raw file is never
     * modified — this is a mix-time chain, the same posture the existing room-noise gate keeps.
     */
    cleanupVoice: zod_1.z.boolean().default(false),
    voiceGain: zod_1.z.number().min(0).max(200).default(100),
    systemGain: zod_1.z.number().min(0).max(200).default(100),
    /** 0 is no duck, 100 is 14 dB. 70 is the 10 dB the plan quotes. */
    duckAmount: zod_1.z.number().min(0).max(100).default(70),
    clickSound: exports.StudioClickSoundSchema.prefault({}),
    /** Last measured integrated loudness, or null before an analysis has run. */
    measuredLufs: zod_1.z.number().nullable().default(null),
});
const SceneCornerSchema = zod_1.z.object({
    x: zod_1.z.number().finite().min(0).max(1),
    y: zod_1.z.number().finite().min(0).max(1),
});
exports.LIGHTING_IDS = ['auto', 'warm', 'cool', 'dramatic', 'neutral'];
/**
 * Visual finish on a posed device. Off by default so existing films do not change appearance.
 * Documentary gates reflection, glow and match-cuts in `resolveFinish` — the stored wish stays.
 */
exports.StudioFinishSchema = zod_1.z.object({
    reflection: zod_1.z
        .object({
        enabled: zod_1.z.boolean().default(false),
        intensity: zod_1.z.number().min(0).max(30).default(14),
    })
        .prefault({}),
    ambientGlow: zod_1.z
        .object({
        enabled: zod_1.z.boolean().default(false),
        intensity: zod_1.z.number().min(0).max(100).default(50),
    })
        .prefault({}),
    grain: zod_1.z
        .object({
        enabled: zod_1.z.boolean().default(false),
        intensity: zod_1.z.number().min(0).max(100).default(40),
    })
        .prefault({}),
    depthOfField: zod_1.z
        .object({
        enabled: zod_1.z.boolean().default(false),
        amount: zod_1.z.number().min(0).max(100).default(40),
    })
        .prefault({}),
    handheld: zod_1.z
        .object({
        enabled: zod_1.z.boolean().default(false),
        intensity: zod_1.z.number().min(0).max(100).default(35),
    })
        .prefault({}),
    /**
     * Absent means the style's own default (on for showcase/kinetic, off for documentary).
     * An explicit false always wins.
     */
    matchCuts: zod_1.z.boolean().optional(),
    lighting: zod_1.z.enum(exports.LIGHTING_IDS).default('auto'),
});
/**
 * The stage the capture sits on.
 *
 * A discriminated union rather than a bag of optional fields, so a photo scene cannot be persisted
 * without the corners it needs and a device scene cannot carry an asset id that means nothing. The
 * default is `flat`, which is what every take in every library already is — this ships without
 * changing the appearance of a single existing recording.
 */
exports.StudioSceneSchema = zod_1.z
    .discriminatedUnion('kind', [
    zod_1.z.object({ kind: zod_1.z.literal('flat') }),
    zod_1.z.object({
        kind: zod_1.z.literal('device'),
        device: zod_1.z.enum(exports.DEVICE_KINDS).default('macbook'),
        /**
         * The shortlist. Empty is the backwards-compatible single-device edit — the same idiom
         * `clips: []` uses for "the original order" — so a project written before this field existed
         * reads back as exactly the take it already was. Two or more and the director varies at cuts.
         */
        devices: zod_1.z.array(zod_1.z.enum(exports.DEVICE_KINDS)).max(8).default([]),
        /** Where the device rests when no shot is moving it. Shots animate away from this and back. */
        pose: exports.StudioPoseSchema.prefault({}),
        /**
         * Whether the stage camera moves at all. `cinematic` opens on an establishing move, drifts
         * gently through each shot and settles at the end (`src/lib/studioDirector.ts` is the one
         * definition of that motion); `still` holds the posed frame exactly where the Maker put it.
         * Defaulting to `cinematic` is safe because the scene feature itself is newer than any
         * shipped build — there is no released take whose appearance this changes.
         */
        motion: zod_1.z.enum(['cinematic', 'still']).default('cinematic'),
        glare: zod_1.z.number().min(0).max(100).default(18),
        contactShadow: zod_1.z.number().min(0).max(100).default(45),
        /**
         * Colour finish id into `DEVICE_FINISHES[kind]`. Absent is the kind's default, which is
         * the pair `DEVICE_METRICS` already used — old projects keep their picture.
         *
         * Named `deviceFinish` because `finish` is already the cinematic grade (grain, glow,
         * screen reflection). Stage look: per-clip overridable, out of `studioEditAffectsOutput`.
         */
        deviceFinish: zod_1.z.string().max(40).optional(),
        /** 0..100. Absent is 0, and 0 is byte-identical to the field being missing. */
        floorReflection: zod_1.z.number().min(0).max(100).optional(),
        /** Which film this is. One row of `STYLES`, never a second code path. */
        style: zod_1.z.enum(exports.SCENE_STYLES).default('showcase'),
        /** Scales every angle and dolly delta linearly. At 0 every shot rests where the Maker put it. */
        intensity: zod_1.z.number().min(0).max(100).default(55),
        /**
         * Reshuffle's counter. Rotates the coverage pattern through one seeded PRNG and nothing else —
         * variety that survives being exported twice has to come from a number the project stores.
         */
        seed: zod_1.z.number().int().min(0).max(1_000_000).default(0),
        grade: exports.StudioGradeSchema.prefault({}),
        /** The Maker's shot intents. Compiled, never stored as shots — see `StudioMarkerSchema`. */
        markers: zod_1.z.array(exports.StudioMarkerSchema).max(200).default([]),
        /** The interludes between clips. Off by default; a take that never asked compiles unchanged. */
        broll: exports.StudioBRollSchema.prefault({}),
        /** Gestures at cuts. Empty is the style's own book. */
        cuts: zod_1.z.array(exports.StudioCutSchema).max(200).default([]),
        /**
         * Grain, glow, reflection, handheld, match-cuts. Off by default so a take that predates
         * this field reads back as the film it already was. Documentary gates a subset in
         * `resolveFinish` rather than rewriting the stored wish.
         */
        finish: exports.StudioFinishSchema.prefault({}),
    }),
    /**
     * The Maker's own mockup photograph. The project stores an *asset id*, never a URL — the
     * renderer derives `gtmedia://scenes/<id>` at draw time. Corners are normalised 0..1 against
     * the photograph, in tl/tr/br/bl order. Studio masks do not cover the backplate, so this
     * kind belongs in `studioEditAffectsOutput`.
     */
    zod_1.z.object({
        kind: zod_1.z.literal('photo'),
        assetId: zod_1.z.string().min(1).max(80),
        corners: zod_1.z.tuple([SceneCornerSchema, SceneCornerSchema, SceneCornerSchema, SceneCornerSchema]),
        /** Source photograph aspect. Absent is the legacy/generated 16:9 plate. */
        aspect: zod_1.z.number().finite().min(0.2).max(5).optional(),
        /** Explicit plate zoom. Absent lets a bundled mockup use its catalog framing. */
        zoom: zod_1.z.number().finite().min(1).max(4).optional(),
        /** Kept for project compatibility; photo framing uses `zoom`, not device pose. */
        pose: exports.StudioPoseSchema.prefault({}),
    }),
])
    .default({ kind: 'flat' });
/**
 * Time as a directorial tool: the stretches where nothing happens play faster.
 *
 * Off by default, and that default is not timidity — every other milestone in this plan rearranges
 * pixels, and this one changes how long the file is. A take that silently came back forty seconds
 * shorter than the Maker recorded would be a bug report, not a feature.
 *
 * **Offered only for a take with no audio track**, and the reason is honest rather than tidy:
 * `Composer.swift` passes the video through and lays the recording's audio beside it, so a
 * variable-rate picture against linear sound desynchronises everything after the first ramp.
 * Pitch-corrected variable-rate audio in AVFoundation is real work and it does not block anything
 * else here, so the feature ships video-only and says so.
 */
exports.StudioRhythmSchema = zod_1.z.object({
    ramps: zod_1.z.boolean().default(false),
    /** The fastest an idle stretch may run. 2.4× is the point past which a viewer loses the thread. */
    maxRate: zod_1.z.number().min(1).max(2.4).default(2),
    /** A stretch shorter than this is not worth ramping — the ramp would be most of it. */
    minIdleMs: zod_1.z.number().min(1500).max(30_000).default(4000),
});
exports.EXPORT_ASPECTS = ['capture', '16:9', '9:16', '1:1', '4:5'];
exports.StudioExportSchema = zod_1.z.object({
    resolution: zod_1.z.enum(['720p', '1080p', '1440p', '4k', 'source']).default('1080p'),
    fps: zod_1.z.union([zod_1.z.literal(24), zod_1.z.literal(30), zod_1.z.literal(60)]).default(30),
    /** 1 is real time. The audio is time-scaled to match, so speech stays in sync. */
    speed: zod_1.z.number().min(0.25).max(4).default(1),
    /**
     * How many bits the picture is worth. `balanced` is the value this encoder always used, so an
     * existing project reads back as the file it would already have produced.
     *
     * Notably *not* in `studioEditAffectsOutput`: a bitrate changes how heavy the frames are, never
     * which pixels are in them. Nothing a mask covers can reappear because the file got larger, so
     * re-opening the review gate over it would be the "made to re-watch ten minutes over a gradient"
     * failure the gate is explicitly designed to avoid.
     */
    quality: zod_1.z.enum(['studio', 'balanced', 'web', 'web-low']).default('balanced'),
    /**
     * The frame the director composes into. `capture` is today's behaviour — the file keeps the
     * recording's own ratio. The others are a re-directed film, not a centre-crop: `resolveStage`
     * and the readability pass both run at the new canvas.
     *
     * Cosmetic for the review gate. A 9:16 frame rearranges pixels the Maker already reviewed and
     * cannot sample a texel the burn destroyed.
     */
    aspect: zod_1.z.enum(exports.EXPORT_ASPECTS).default('capture'),
    /**
     * Whether `drawFrame` burns captions into the MP4. Preview still follows `captions.enabled`.
     * Default true so a take that already drew captions keeps drawing them.
     */
    burnCaptions: zod_1.z.boolean().default(true),
    /** Write captions.srt / captions.vtt next to the MP4. */
    captionSidecar: zod_1.z.boolean().default(false),
    /** Write a YouTube-format .chapters.txt next to the MP4. */
    chapters: zod_1.z.boolean().default(false),
    /** Session-relative cover still, e.g. `thumbnail.png`. Empty is none. */
    thumbnail: zod_1.z.string().max(240).default(''),
});
/**
 * A source range in the edit timeline. Its array position is its playback position.
 *
 * `rate` is how fast this piece plays, and it is the one field here that is a statement about
 * *which* source instants the file contains rather than about which footage it draws from. It
 * belongs to the clip rather than to the project because a Maker slows down the one gesture that
 * matters and leaves the rest alone — which is the whole difference between this and
 * `export.speed`, a single number over the entire take.
 *
 * Defaulted rather than required, so every project written before this field existed reads back as
 * exactly the take it already was.
 */
/**
 * What one clip looks like, where that differs from the take.
 *
 * ## Why only these fields
 *
 * A clip is a window onto *source* time, and two clips may look at the same source instant — a
 * duplicated gesture, a moment shown twice. So anything anchored in source time cannot be a
 * per-clip setting without becoming ambiguous the first time a Maker duplicates a piece: the
 * camera keyframes and the masks are both resolved from the recording's own clock, and asking two
 * clips what the zoom is at source 12.4s can produce two answers for one frame. Those stay take-
 * wide, and the panels say so.
 *
 * What is here is resolved in *stage* space instead — the ground the picture sits on, the mockup it
 * sits in, how it is turned and lit, and how the pointer reads. Every one of those is a property of
 * the frame being drawn rather than of the footage being drawn, so a clip can hold its own without
 * any other clip having an opinion about it.
 *
 * Device-to-device edits keep the **film** take-wide. Style, intensity, the seed, the grade and the
 * markers are the director's; `resolveSceneDirection` reads those once and varies only the device
 * and resting pose per shot. `scene` is the deliberate exception needed when the kind itself
 * changes: one clip may be flat or photographic while its neighbours use the take's device stage.
 *
 * Every field is optional, and absent means the take's. A project written before this existed
 * therefore reads back as exactly the take it already was.
 */
exports.StudioClipLookSchema = zod_1.z.object({
    background: exports.StudioBackgroundSchema.optional(),
    cursor: exports.StudioCursorSchema.optional(),
    /** A scene-kind change belongs to this clip rather than being redirected to the whole take. */
    scene: exports.StudioSceneSchema.optional(),
    /** Only read on a device scene: a flat take has no mockup for a clip to disagree about. */
    device: zod_1.z.enum(exports.DEVICE_KINDS).optional(),
    pose: exports.StudioPoseSchema.optional(),
    glare: zod_1.z.number().min(0).max(100).optional(),
    contactShadow: zod_1.z.number().min(0).max(100).optional(),
    deviceFinish: zod_1.z.string().max(40).optional(),
    floorReflection: zod_1.z.number().min(0).max(100).optional(),
    /** Per-clip talking-head layout. Absent is the take's. */
    webcam: exports.StudioWebcamSchema.optional(),
});
exports.StudioClipSchema = zod_1.z
    .object({
    id: zod_1.z.string().min(1).max(120),
    sourceStartMs: zod_1.z.number().min(0),
    sourceEndMs: zod_1.z.number().min(0),
    /** 1 is real time. Same range as `export.speed`, and the two multiply. */
    rate: zod_1.z.number().min(0.25).max(4).default(1),
    /** This piece's own frame, stage and pointer. Absent is the take's. */
    look: exports.StudioClipLookSchema.optional(),
})
    .refine((clip) => clip.sourceEndMs > clip.sourceStartMs, { message: 'clip end must follow its start' });
exports.StudioProjectSchema = zod_1.z.object({
    trimStartMs: zod_1.z.number().min(0).default(0),
    /** null means "to the end of the recording", which is what an untrimmed take is. */
    trimEndMs: zod_1.z.number().min(0).nullable().default(null),
    /** Empty is the backwards-compatible identity edit; the first cut or move materialises it. */
    clips: zod_1.z.array(exports.StudioClipSchema).max(400).default([]),
    background: exports.StudioBackgroundSchema.prefault({}),
    scene: exports.StudioSceneSchema.prefault({ kind: 'flat' }),
    cursor: exports.StudioCursorSchema.prefault({}),
    zoom: exports.StudioZoomSchema.prefault({}),
    rhythm: exports.StudioRhythmSchema.prefault({}),
    export: exports.StudioExportSchema.prefault({}),
    keystrokeDisplay: exports.StudioKeystrokeDisplaySchema.prefault({}),
    /** Anchored to a clip instance and a recorded instant; `drawFrame` holds them on the picture. */
    keystrokes: zod_1.z.array(exports.StudioKeystrokeSchema).max(200).default([]),
    /**
     * Whether the recorder's captured chords have already been folded into `keystrokes`.
     *
     * Seeding runs exactly once, the first time the editor opens a take (`seedRecordedKeystrokes`),
     * so a Maker who deletes an auto-placed cue does not get it back on every reload. Cosmetic for
     * the export gate — it changes no reviewed pixel — so it is deliberately absent from
     * `studioEditAffectsOutput`, like the presentation cues it gates.
     */
    keystrokesSeeded: zod_1.z.boolean().default(false),
    masks: zod_1.z.array(exports.StudioMaskSchema).max(200).default([]),
    /**
     * The score. Off by default. Not in `studioEditAffectsOutput`: music rearranges no reviewed
     * pixels and destroys nothing. A broken score is salvaged to `null` (mood tables) and said.
     */
    music: music_1.StudioMusicSchema.prefault({}),
    captions: exports.StudioCaptionsSchema.prefault({}),
    webcam: exports.StudioWebcamSchema.prefault({}),
    audio: exports.StudioAudioSchema.prefault({}),
    /**
     * Set once the Maker has looked at the take on the review screen. The export refuses to run
     * without it, for the same reason the guide pipeline refuses to generate without an
     * acknowledged redaction pass: nobody should be able to publish footage nobody has watched.
     */
    reviewedAt: zod_1.z.string().max(40).default(''),
});
function issueFrom(kind, raw, error) {
    const first = error.issues[0];
    const record = (raw && typeof raw === 'object' ? raw : {});
    const label = typeof record.label === 'string' ? record.label.slice(0, 120) : '';
    return {
        kind,
        raw,
        label,
        reason: first ? `${first.path.join('.') || kind} ${first.message}` : 'could not be read',
    };
}
/**
 * Read a stored blob, and say what could not be read.
 *
 * Salvage is per field and per entry — the old behaviour, where any failure anywhere returned a
 * fresh default, meant one out-of-range number could read back as an empty project and the editor's
 * autosave would then *persist* that emptiness. What is new is that the casualties are returned
 * rather than discarded, because a dropped mask is a region that is no longer redacted and nothing
 * downstream could previously tell the difference between four masks and five-minus-one.
 */
function inspectStudio(raw) {
    const parsed = exports.StudioProjectSchema.safeParse(raw ?? {});
    if (parsed.success) {
        const source = (raw && typeof raw === 'object' ? raw : {});
        return { project: parsed.data, issues: [], musicSalvaged: (0, music_1.musicScoreSalvaged)(source.music) };
    }
    const source = (raw && typeof raw === 'object' ? raw : {});
    const defaults = exports.StudioProjectSchema.parse({});
    const out = { ...defaults };
    const issues = [];
    for (const key of Object.keys(exports.StudioProjectSchema.shape)) {
        const single = exports.StudioProjectSchema.shape[key].safeParse(source[key]);
        if (single.success)
            out[key] = single.data;
        else if (key === 'scene') {
            /**
             * A bad marker must not cost the Maker their stage.
             *
             * Per-field salvage means one unreadable entry inside `scene` takes the whole scene with it —
             * the device, the pose, the shortlist — and the editor's autosave then persists that loss.
             * Markers get the same per-entry treatment masks and clips already have, for the same reason.
             *
             * They do **not** get quarantine, and that asymmetry is deliberate: a dropped mask is a region
             * that is silently no longer redacted, while a dropped marker is a camera move that did not
             * happen. One is a safety failure and the other is an edit.
             */
            const scene = (source.scene && typeof source.scene === 'object' ? source.scene : {});
            let fixed = { ...scene };
            let touched = false;
            if (Array.isArray(scene.markers)) {
                fixed = {
                    ...fixed,
                    markers: scene.markers.filter((marker) => exports.StudioMarkerSchema.safeParse(marker).success),
                };
                touched = true;
            }
            if (Array.isArray(scene.cuts)) {
                fixed = {
                    ...fixed,
                    cuts: scene.cuts.filter((cut) => exports.StudioCutSchema.safeParse(cut).success),
                };
                touched = true;
            }
            /**
             * Same salvage for b-roll gaps: one unreadable cut pick must not take the stage with it.
             * Gaps get no quarantine (a dropped pick is a cutaway that did not happen, not a region
             * silently unredacted).
             */
            const broll = scene.broll && typeof scene.broll === 'object' ? scene.broll : null;
            if (broll && Array.isArray(broll.gaps)) {
                fixed = {
                    ...fixed,
                    broll: {
                        ...broll,
                        gaps: broll.gaps.filter((gap) => exports.StudioBRollGapSchema.safeParse(gap).success),
                    },
                };
                touched = true;
            }
            if (touched) {
                const retry = exports.StudioProjectSchema.shape.scene.safeParse(fixed);
                if (retry.success)
                    out.scene = retry.data;
            }
        }
    }
    // Masks are the expensive artifact — keep every one that is individually sound, and keep the
    // wreckage of every one that is not.
    if (Array.isArray(source.masks)) {
        const kept = [];
        for (const mask of source.masks.slice(0, 200)) {
            const result = exports.StudioMaskSchema.safeParse(mask);
            if (result.success)
                kept.push(result.data);
            else
                issues.push(issueFrom('mask', mask, result.error));
        }
        out.masks = kept;
    }
    if (Array.isArray(source.clips)) {
        const kept = [];
        for (const clip of source.clips.slice(0, 400)) {
            const result = exports.StudioClipSchema.safeParse(clip);
            if (result.success)
                kept.push(result.data);
            else
                issues.push(issueFrom('clip', clip, result.error));
        }
        out.clips = kept;
    }
    // An unreadable presentation cue costs only that cue, never every authored keyboard action.
    if (Array.isArray(source.keystrokes)) {
        out.keystrokes = source.keystrokes
            .slice(0, 200)
            .map((entry) => exports.StudioKeystrokeSchema.safeParse(entry))
            .filter((entry) => entry.success)
            .map((entry) => entry.data);
    }
    const captions = source.captions && typeof source.captions === 'object' ? source.captions : null;
    if (captions && Array.isArray(captions.words)) {
        const kept = captions.words
            .slice(0, 20_000)
            .map((word) => exports.StudioCaptionWordSchema.safeParse(word))
            .filter((word) => word.success)
            .map((word) => word.data);
        const cards = Array.isArray(captions.cards)
            ? captions.cards
                .slice(0, 80)
                .map((card) => exports.StudioCaptionCardSchema.safeParse(card))
                .filter((card) => card.success)
                .map((card) => card.data)
            : [];
        const retry = exports.StudioCaptionsSchema.safeParse({ ...captions, words: kept, cards });
        if (retry.success)
            out.captions = retry.data;
    }
    /**
     * A broken score must not take the rest of the take with it, and must not be silently
     * replaced with a different performance. Drop the score, keep the Maker's mood and volume,
     * and say so — the editor reads `musicSalvaged`.
     */
    const salvagedMusic = (0, music_1.musicScoreSalvaged)(source.music);
    if (source.music !== undefined)
        out.music = (0, music_1.parseMusic)(source.music);
    return { project: exports.StudioProjectSchema.parse(out), issues, musicSalvaged: salvagedMusic };
}
/** The project alone, for the many callers that have no use for the casualty list. */
function normalizeStudio(raw) {
    return inspectStudio(raw).project;
}
/**
 * The write path. The editor always sends a complete project, so an invalid one is a bug to
 * surface — not something to quietly replace with defaults, which is how a bad save once
 * destroyed every mask in a take.
 */
function parseStudioStrict(raw) {
    const parsed = exports.StudioProjectSchema.safeParse(raw ?? {});
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`The edit could not be saved: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'invalid project'}`);
    }
    return parsed.data;
}
exports.DEFAULT_STUDIO = exports.StudioProjectSchema.parse({});
// ---------------------------------------------------------------- the export gate
/**
 * Whether a take may be exported at all.
 *
 * Two conditions, both load-bearing. The Maker has to have watched it — masks they never looked
 * for cannot have been drawn — and there has to be footage to burn. This is the studio's
 * equivalent of `redactionService.assertAcknowledged()`, and like it, it is checked in main so
 * that a renderer bug cannot skip the only pass this footage gets.
 *
 * Raw footage has no other path out of the app. The export does not copy the captured movie; it
 * re-encodes frames the compositor has already filled the mask rectangles into. So "not
 * reviewed" is not a soft warning here — it is the difference between a file existing and not.
 */
function studioExportRefusal(project, mediaState, unreadableMasks = 0) {
    /**
     * Fail closed on evidence we could not read. This outranks "not reviewed" because it is the more
     * specific problem and the more alarming one: the Maker may well have looked at the take, and the
     * thing they cannot know is that one of the rectangles they drew did not survive the round trip.
     */
    if (unreadableMasks > 0) {
        const plural = unreadableMasks === 1 ? 'one of this take’s masks' : `${unreadableMasks} of this take’s masks`;
        return `We could not read ${plural}, so we cannot promise everything you covered is still covered. Look through the take again and re-mask anything that needs it.`;
    }
    if (mediaState === 'swept') {
        return 'This recording’s footage was deleted after sitting unreviewed for seven days. The steps are still here, but the video is gone.';
    }
    if (!mediaState)
        return 'There is no footage attached to this recording.';
    if (!project.reviewedAt) {
        return 'Watch the take through before exporting it, and mask anything that should not leave this machine. Masks are burned into the exported file and cannot be undone afterwards.';
    }
    return null;
}
/**
 * Whether an edit changes which pixels would ship.
 *
 * Moving a mask, retrimming, or changing the speed all do, so they re-open the review gate.
 * Cosmetic settings — the background, the cursor size — do not: making a Maker re-watch ten
 * minutes because they tried a different gradient would train them to click through the review,
 * which is the opposite of what the gate is for.
 */
/** A clip's statement about *what* ships: which source it names, in what order, at what rate. */
function clipCut(clip) {
    return `${clip.id}:${clip.sourceStartMs}:${clip.sourceEndMs}:${clip.rate}`;
}
function studioEditAffectsOutput(previous, next) {
    /**
     * The scene is cosmetic **for a device**, and only for a device.
     *
     * A pose rearranges pixels the Maker already reviewed and cannot reveal a texel a capture-space
     * mask destroyed — masks travel with the picture by construction. A *photo* scene is different
     * in kind: it composites imagery nobody reviewed into the only file that leaves the machine, and
     * studio masks do not cover it. So when that arrives (M5) its asset and corners belong in this
     * predicate, and the device's pose still does not. See §7.2.
     *
     * The same argument covers everything the second cinematic milestone added, and it is worth
     * stating rather than leaving to inference. A **style**, an **intensity**, a **seed**, a
     * **marker** and every entry in the **grade** move, light and finish pixels the Maker already
     * reviewed; none of them can sample a texel the burn destroyed, because the burn happens in
     * capture space before any of this touches a frame. Making someone re-watch ten minutes for
     * trying `kinetic` is exactly the training-to-click-through the gate exists to avoid.
     *
     * **Speed ramps are the exception, and they belong with `export.speed`** — they change which
     * source instants the file samples and how long it is, which is a statement about what ships
     * rather than about how it looks.
     */
    if (JSON.stringify(previous.masks) !== JSON.stringify(next.masks))
        return true;
    // The cut, not the clip: most of `look` is a per-clip background, mockup, pose and pointer, and is
    // cosmetic by the argument above. Clip photo scenes are compared separately by `projectPhotoCut`
    // below. Comparing the whole clip would still re-open the gate for a gradient on one piece.
    if (previous.clips.map(clipCut).join('|') !== next.clips.map(clipCut).join('|'))
        return true;
    if (previous.trimStartMs !== next.trimStartMs)
        return true;
    if (previous.trimEndMs !== next.trimEndMs)
        return true;
    if (previous.export.speed !== next.export.speed)
        return true;
    if (JSON.stringify(previous.rhythm) !== JSON.stringify(next.rhythm))
        return true;
    // Muting changes which recorded content ships. In particular, unmuting after a silent review
    // must re-open the gate before previously unheard microphone/system audio can leave the app.
    if (previous.audio.muted !== next.audio.muted)
        return true;
    /**
     * Camera pixels are unreviewed imagery of the Maker's own face and room — they ship, so a
     * layout that changes which of them are visible re-opens the gate. Cosmetic restyling of the
     * *screen* track (gradient, pointer size) still does not.
     */
    if (webcamCut(previous) !== webcamCut(next))
        return true;
    /**
     * A photo scene composites imagery nobody reviewed into the only file that leaves the
     * machine, and studio masks do not cover the backplate. Device pose still does not belong
     * here — it rearranges reviewed pixels.
     */
    if (projectPhotoCut(previous) !== projectPhotoCut(next))
        return true;
    /**
     * Music is not compared, and that is the point. A score rearranges no reviewed pixels
     * and destroys nothing — the one audio-derived artefact is a list of gain numbers,
     * recomputed freely. Making a Maker re-watch ten minutes for a volume change is the
     * exact failure this predicate exists to avoid.
     */
    return false;
}
function webcamCut(project) {
    const take = JSON.stringify({
        enabled: project.webcam?.enabled ?? false,
        shape: project.webcam?.shape ?? 'rounded',
        anchor: project.webcam?.anchor ?? 'bottom-right',
        size: project.webcam?.size ?? 0.22,
    });
    const clips = (project.clips ?? [])
        .map((clip) => {
        const cam = clip.look?.webcam;
        return cam ? `${clip.id}:${cam.enabled}:${cam.shape}:${cam.anchor}:${cam.size}` : clip.id;
    })
        .join('|');
    return `${take}|${clips}`;
}
function photoCut(scene) {
    if (scene.kind !== 'photo')
        return '';
    return `photo:${scene.assetId}:${scene.aspect ?? 'legacy'}:${scene.zoom ?? 'auto'}:${JSON.stringify(scene.corners)}`;
}
/** Every unreviewed backplate that can ship, including a scene owned by one clip. */
function projectPhotoCut(project) {
    return [
        `take:${photoCut(project.scene)}`,
        ...(project.clips ?? []).map((clip) => `${clip.id}:${clip.look?.scene ? photoCut(clip.look.scene) : ''}`),
    ].join('|');
}
//# sourceMappingURL=studio.js.map