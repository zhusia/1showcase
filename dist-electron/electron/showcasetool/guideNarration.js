"use strict";
/**
 * A clean narration script from a guide's steps.
 *
 * Pure and electron-free so `verify:core` can import it from `dist-electron/` the same way
 * it imports `machinePolicy.ts`. Timing is word-count ÷ 150 wpm, never a wall clock.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NARRATION_WPM = void 0;
exports.wordCount = wordCount;
exports.estimatedMs = estimatedMs;
exports.formatClock = formatClock;
exports.stepSpokenText = stepSpokenText;
exports.narrationCues = narrationCues;
exports.narrationScript = narrationScript;
exports.narrationDurationMs = narrationDurationMs;
exports.NARRATION_WPM = 150;
function wordCount(text) {
    return text
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
}
function estimatedMs(text, wpm = exports.NARRATION_WPM) {
    const words = wordCount(text);
    if (!words)
        return 0;
    return Math.round((words / Math.max(1, wpm)) * 60_000);
}
function formatClock(ms) {
    const clamped = Math.max(0, Math.round(ms));
    const m = Math.floor(clamped / 60_000);
    const s = Math.floor((clamped % 60_000) / 1000);
    return `${m}:${String(s).padStart(2, '0')}`;
}
function stepSpokenText(step) {
    const parts = [step.title, step.body, step.why].filter((part) => typeof part === 'string' && part.trim());
    return parts.join(' ').replace(/\s+/g, ' ').trim();
}
function narrationCues(guide) {
    const cues = [];
    let at = 0;
    let chapter = '';
    for (const step of guide.steps) {
        if (step.chapter && step.chapter.trim())
            chapter = step.chapter.trim();
        const text = stepSpokenText(step);
        const span = Math.max(1500, estimatedMs(text || step.title));
        cues.push({ fromMs: at, toMs: at + span, chapter, title: step.title, text: text || step.title });
        at += span;
    }
    return cues;
}
function narrationScript(guide) {
    const cues = narrationCues(guide);
    const total = cues.length ? cues[cues.length - 1].toMs : 0;
    const lines = [
        `# ${guide.title || 'Narration'}`,
        '',
        `Estimated ${formatClock(total)} at ${exports.NARRATION_WPM} words per minute.`,
        '',
    ];
    let lastChapter = '';
    for (const cue of cues) {
        if (cue.chapter && cue.chapter !== lastChapter) {
            lines.push(`## ${cue.chapter}`);
            lines.push('');
            lastChapter = cue.chapter;
        }
        lines.push(`${formatClock(cue.fromMs)}–${formatClock(cue.toMs)} — ${cue.title}`);
        if (cue.text && cue.text !== cue.title)
            lines.push(cue.text);
        lines.push('');
    }
    return lines.join('\n').trim() + '\n';
}
function narrationDurationMs(guide) {
    const cues = narrationCues(guide);
    return cues.length ? cues[cues.length - 1].toMs : 0;
}
//# sourceMappingURL=guideNarration.js.map