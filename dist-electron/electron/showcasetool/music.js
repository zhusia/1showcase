"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScoreRequestSchema = exports.DEFAULT_MUSIC = exports.StudioMusicSchema = exports.StudioMusicClipSchema = exports.SCORE_SOURCES = exports.DuckRampSchema = exports.StudioScoreSchema = exports.SCORE_HITS = exports.SCORE_VOICES = exports.PRO_MOODS = exports.FREE_MOODS = exports.SCORE_MOODS = exports.DEGREES = exports.KEYS = void 0;
exports.parseScore = parseScore;
exports.scoreFitsDuration = scoreFitsDuration;
exports.parseMusic = parseMusic;
exports.musicScoreSalvaged = musicScoreSalvaged;
exports.clampMusicMood = clampMusicMood;
exports.applyMusicEntitlement = applyMusicEntitlement;
exports.parseScoreRequest = parseScoreRequest;
exports.buildScoreRequest = buildScoreRequest;
const zod_1 = require("zod");
/**
 * The studio score: a strict description of notes, never bytes.
 *
 * Pure and electron-free — `verify:core` imports this from `dist-electron/` the same way it
 * imports `machinePolicy.ts`. The score is the one object an outside model authors, so the
 * schema is a `strictObject`: a smuggled extra key must fail validation rather than be
 * stripped. A score is structurally incapable of carrying bytes, a path to fetch, or
 * anyone's content.
 *
 * The engine (`src/lib/studioScore.ts`) is the only thing that turns this into audio. The
 * composer (`src/lib/studioCompose.ts`) is the only thing that writes one from a film.
 */
exports.KEYS = [
    'C',
    'C#',
    'D',
    'Eb',
    'E',
    'F',
    'F#',
    'G',
    'Ab',
    'A',
    'Bb',
    'B',
    'Cm',
    'C#m',
    'Dm',
    'Ebm',
    'Em',
    'Fm',
    'F#m',
    'Gm',
    'G#m',
    'Am',
    'Bbm',
    'Bm',
];
/** Scale degrees, not frequencies. The engine owns what a `V` in `Dm` sounds like. */
exports.DEGREES = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'bVII', 'i', 'III', 'iv', 'v', 'VI', 'VII'];
exports.SCORE_MOODS = ['calm', 'warm', 'focus', 'bright', 'epic', 'night'];
exports.FREE_MOODS = ['calm', 'warm', 'focus', 'bright'];
exports.PRO_MOODS = ['epic', 'night'];
exports.SCORE_VOICES = ['pad', 'bass', 'arp', 'pulse', 'shimmer', 'riser'];
exports.SCORE_HITS = ['riser', 'resolve', 'lift'];
exports.StudioScoreSchema = zod_1.z.strictObject({
    version: zod_1.z.literal(1),
    tempo: zod_1.z.number().min(56).max(140),
    key: zod_1.z.enum(exports.KEYS),
    mood: zod_1.z.enum(exports.SCORE_MOODS),
    /** Song sections, half-open on the OUTPUT clock. Boundaries must be cut/arrival moments. */
    sections: zod_1.z
        .array(zod_1.z.strictObject({
        atMs: zod_1.z.number().min(0),
        energy: zod_1.z.number().min(0).max(1),
        chords: zod_1.z.array(zod_1.z.enum(exports.DEGREES)).min(1).max(8),
        voices: zod_1.z.array(zod_1.z.enum(exports.SCORE_VOICES)).max(5),
    }))
        .min(1)
        .max(64),
    /** One-shot punctuation: risers into arrivals, a resolve at the settle. */
    hits: zod_1.z
        .array(zod_1.z.strictObject({
        atMs: zod_1.z.number().min(0),
        kind: zod_1.z.enum(exports.SCORE_HITS),
    }))
        .max(32),
    seed: zod_1.z.number().int().min(0),
});
/**
 * Gain points on the output clock. Derived locally from a speech envelope — numbers only,
 * never samples. Applied to the bed, never to the recording.
 */
exports.DuckRampSchema = zod_1.z.strictObject({
    atMs: zod_1.z.number().min(0),
    /** Linear gain, 0..1. 1 is unducked. */
    gain: zod_1.z.number().min(0).max(1),
});
exports.SCORE_SOURCES = ['engine', 'ai'];
/**
 * One scored piece on the output clock. Empty `clips` on the parent still means "one bed
 * covering the film" — this schema is only for pieces the Maker has actually cut or added.
 */
exports.StudioMusicClipSchema = zod_1.z.object({
    id: zod_1.z.string().min(1).max(48),
    startMs: zod_1.z.number().min(0),
    endMs: zod_1.z.number().min(0),
    mood: zod_1.z.enum(exports.SCORE_MOODS).default('focus'),
    intensity: zod_1.z.number().min(0).max(100).default(55),
    seed: zod_1.z.number().int().min(0).max(1_000_000).default(0),
    source: zod_1.z.enum(exports.SCORE_SOURCES).default('engine'),
    score: exports.StudioScoreSchema.nullable().default(null),
    lockedAt: zod_1.z.string().max(40).default(''),
});
/**
 * What the Maker asked for, and the composed description. Additive and defaulted both ways.
 * Off is the default: music is asked for, never assumed.
 */
exports.StudioMusicSchema = zod_1.z.object({
    enabled: zod_1.z.boolean().default(false),
    source: zod_1.z.enum(exports.SCORE_SOURCES).default('engine'),
    mood: zod_1.z.enum(exports.SCORE_MOODS).default('focus'),
    intensity: zod_1.z.number().min(0).max(100).default(55),
    seed: zod_1.z.number().int().min(0).max(1_000_000).default(0),
    volume: zod_1.z.number().min(0).max(100).default(70),
    duckUnderSpeech: zod_1.z.boolean().default(true),
    includeTitleInPrompt: zod_1.z.boolean().default(true),
    /** Null means compose from the mood tables. */
    score: exports.StudioScoreSchema.nullable().default(null),
    /** A non-empty timestamp pins the score against recomposition. */
    lockedAt: zod_1.z.string().max(40).default(''),
    /**
     * Cut pieces. Empty is the legacy single bed (`score` covers the film). A dropped clip is a
     * bed that did not play, not a region silently unredacted — no quarantine.
     */
    clips: zod_1.z.array(exports.StudioMusicClipSchema).max(32).default([]),
    /** One-shot assist: nudge clip boundaries that already sit near a score hit. */
    snapCuts: zod_1.z.boolean().default(false),
    /** Dip the bed slightly during fast camera moves. */
    energyDuck: zod_1.z.boolean().default(false),
});
exports.DEFAULT_MUSIC = exports.StudioMusicSchema.parse({});
/** Parse a model reply. Extra keys, a URL-shaped string, an unknown key — all refuse. */
function parseScore(raw) {
    const parsed = exports.StudioScoreSchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
            ok: false,
            error: issue ? `${issue.path.join('.') || 'score'} ${issue.message}` : 'the score could not be read',
        };
    }
    return { ok: true, score: parsed.data };
}
/**
 * A section or hit that starts at or past the take's end is a score for a different film.
 * The schema cannot know the duration; this is the check `verify:core` names.
 */
function scoreFitsDuration(score, durationMs) {
    if (!(durationMs > 0))
        return false;
    if (score.sections.some((section) => section.atMs >= durationMs))
        return false;
    if (score.hits.some((hit) => hit.atMs > durationMs))
        return false;
    return true;
}
function parseMusicClips(raw) {
    if (!Array.isArray(raw))
        return [];
    const clips = [];
    for (const entry of raw.slice(0, 32)) {
        const parsed = exports.StudioMusicClipSchema.safeParse(entry);
        if (parsed.success) {
            clips.push(parsed.data);
            continue;
        }
        const record = entry && typeof entry === 'object' ? entry : {};
        const salvaged = exports.StudioMusicClipSchema.safeParse({ ...record, score: null });
        if (salvaged.success)
            clips.push(salvaged.data);
    }
    return clips;
}
function parseMusic(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const withClips = { ...source, clips: parseMusicClips(source.clips) };
    const parsed = exports.StudioMusicSchema.safeParse(withClips);
    if (parsed.success)
        return parsed.data;
    const withoutScore = { ...withClips, score: null };
    const salvaged = exports.StudioMusicSchema.safeParse(withoutScore);
    return salvaged.success ? salvaged.data : exports.DEFAULT_MUSIC;
}
function scoreUnreadable(raw) {
    return raw != null && !exports.StudioScoreSchema.safeParse(raw).success;
}
/** True when the stored blob had a score that could not be read. */
function musicScoreSalvaged(raw) {
    if (!raw || typeof raw !== 'object')
        return false;
    const record = raw;
    if (scoreUnreadable(record.score))
        return true;
    if (!Array.isArray(record.clips))
        return false;
    return record.clips.some((clip) => {
        if (!clip || typeof clip !== 'object')
            return false;
        return scoreUnreadable(clip.score);
    });
}
/**
 * Premium moods clamp to the nearest free one. Never refused — a free Maker who picks `epic`
 * still gets a score, just not that row of the table.
 */
function clampMusicMood(mood, pro) {
    if (pro)
        return mood;
    if (mood === 'epic')
        return 'bright';
    if (mood === 'night')
        return 'calm';
    return mood;
}
function applyMusicEntitlement(music, pro) {
    if (pro)
        return music;
    const mood = clampMusicMood(music.mood, false);
    const clampScore = (score) => score && exports.PRO_MOODS.includes(score.mood)
        ? { ...score, mood: clampMusicMood(score.mood, false) }
        : score;
    return {
        ...music,
        mood,
        score: clampScore(music.score),
        source: 'engine',
        clips: (music.clips ?? []).map((clip) => ({
            ...clip,
            mood: clampMusicMood(clip.mood, false),
            score: clampScore(clip.score),
            source: 'engine',
        })),
    };
}
// ---------------------------------------------------------------- the request — shape and intent only
/**
 * What may leave the machine for an AI compose. Strict: a field that is not on this list
 * fails validation rather than being stripped. Built here so `verify:core` can grep this
 * module for the names that must never appear.
 */
exports.ScoreRequestSchema = zod_1.z.strictObject({
    version: zod_1.z.literal(1),
    durationMs: zod_1.z.number().min(1).max(4 * 60 * 60 * 1000),
    sectionCount: zod_1.z.number().int().min(1).max(64),
    sectionDurations: zod_1.z.array(zod_1.z.number().min(0)).max(64),
    cuts: zod_1.z.array(zod_1.z.number().min(0)).max(64),
    arrivals: zod_1.z.array(zod_1.z.number().min(0)).max(64),
    zoomDensity: zod_1.z.number().min(0).max(1),
    hasSpeech: zod_1.z.boolean(),
    rampSpans: zod_1.z.array(zod_1.z.strictObject({ fromMs: zod_1.z.number().min(0), toMs: zod_1.z.number().min(0) })).max(64),
    mood: zod_1.z.enum(exports.SCORE_MOODS),
    style: zod_1.z.string().max(40),
    intensity: zod_1.z.number().min(0).max(100),
    seed: zod_1.z.number().int().min(0),
    /** Present only when the Maker left "include title" checked. */
    title: zod_1.z.string().max(120).optional(),
});
function parseScoreRequest(raw) {
    const parsed = exports.ScoreRequestSchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
            ok: false,
            error: issue ? `${issue.path.join('.') || 'request'} ${issue.message}` : 'the request could not be read',
        };
    }
    return { ok: true, request: parsed.data };
}
/**
 * Build the payload the model is allowed to see. Callers hand in already-numeric film shape
 * — this function never reads a take, a session, or a file.
 */
function buildScoreRequest(input) {
    const sectionDurations = input.sectionDurations.slice(0, 64).map((ms) => Math.max(0, ms));
    return exports.ScoreRequestSchema.parse({
        version: 1,
        durationMs: Math.max(1, input.durationMs),
        sectionCount: Math.max(1, Math.min(64, sectionDurations.length || 1)),
        sectionDurations,
        cuts: input.cuts.slice(0, 64).map((ms) => Math.max(0, ms)),
        arrivals: input.arrivals.slice(0, 64).map((ms) => Math.max(0, ms)),
        zoomDensity: Math.max(0, Math.min(1, input.zoomDensity)),
        hasSpeech: input.hasSpeech,
        rampSpans: input.rampSpans.slice(0, 64),
        mood: input.mood,
        style: input.style.slice(0, 40),
        intensity: Math.max(0, Math.min(100, input.intensity)),
        seed: Math.max(0, Math.floor(input.seed)),
        ...(input.title ? { title: input.title.slice(0, 120) } : {}),
    });
}
//# sourceMappingURL=music.js.map