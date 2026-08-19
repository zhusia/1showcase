"use strict";
/**
 * The rules that decide what the machine recorder may point at, and how a captured desktop
 * window is addressed once it is stored (docs/machine-record-plan.md §4, §5.2).
 *
 * Deliberately free of any `electron` import. Everything here is pure string logic, which is
 * what lets `verify:core` import it from `dist-electron/` and check the safety rules without
 * booting an app — the same reason `redactionPatterns.ts` stays importable.
 *
 * ## What replaced window-only capture
 *
 * The first machine recorder could capture exactly one window, and that scoping *was* the
 * redaction story: a source with no DOM has no Layer 1, so nothing could take a secret back out
 * of a frame after the fact. A screen recorder that cannot record the screen is not a screen
 * recorder, so the guarantee moved rather than being dropped. It is now three things:
 *
 *   1. **An explicit target, chosen before the recording starts.** A display, a window, or a
 *      dragged-out region. There is no "record everything" default and no target the Maker did
 *      not name.
 *   2. **The blocklist below**, checked against the target *and*, for a display or region, every
 *      window visible on it at the moment recording starts.
 *   3. **The burn.** Raw footage has no export path at all — `media_state` stays 'raw', and the
 *      only thing that produces a file is the export, which composites opaque mask fills into
 *      new frames and writes 'burned'. Unreviewed footage is deleted after seven days.
 *
 * (3) is the load-bearing one, and it is the reason (1) and (2) can be heuristics without the
 * product's promise resting on them.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BLOCKED_WINDOW_PATTERNS = void 0;
exports.blockedLabel = blockedLabel;
exports.blockedWindowReason = blockedWindowReason;
exports.blockedOnDisplayReason = blockedOnDisplayReason;
exports.targetRiskNote = targetRiskNote;
exports.describeTarget = describeTarget;
exports.slugifyWindowTitle = slugifyWindowTitle;
exports.appUriFor = appUriFor;
exports.isAppUri = isAppUri;
/**
 * Windows that must never be a recording target, matched case-insensitively against the
 * window title and the owning application's name.
 *
 * A heuristic, and described as one in the UI. It catches the Maker who aims straight at a
 * password manager, and — for a display capture — the one who forgot it was open on that
 * screen. It cannot catch a vault that opens halfway through a take, which is what the mask
 * pass before export is for.
 */
exports.BLOCKED_WINDOW_PATTERNS = [
    { label: '1Password', pattern: /\b1password\b/i },
    { label: 'Keychain Access', pattern: /\bkeychain\s*access\b/i },
    { label: 'Bitwarden', pattern: /\bbitwarden\b/i },
    { label: 'LastPass', pattern: /\blastpass\b/i },
    { label: 'Dashlane', pattern: /\bdashlane\b/i },
    { label: 'KeePass', pattern: /\bkeepass(xc)?\b/i },
    { label: 'Proton Pass', pattern: /\bproton\s*pass\b/i },
    { label: 'an authenticator app', pattern: /\bauthenticator\b/i },
    { label: 'the system passwords panel', pattern: /^passwords?$|\bpasswords\s*(—|-|·)\s/i },
    { label: 'Windows Security', pattern: /\bwindows\s*security\b/i },
    { label: 'Credential Manager', pattern: /\bcredential\s*manager\b/i },
];
/**
 * Whether `text` matches a blocked secret-app pattern. Empty input never matches — the
 * empty-title refusal for a *chosen* window target is separate, in `blockedWindowReason`.
 */
function blockedLabel(text) {
    const value = (text ?? '').trim();
    if (!value)
        return null;
    for (const { label, pattern } of exports.BLOCKED_WINDOW_PATTERNS) {
        if (pattern.test(value))
            return label;
    }
    return null;
}
/**
 * Why this window may not be recorded, or null when it may be. Returns the sentence shown to
 * the Maker, so it names the match rather than saying "blocked".
 *
 * Empty title is refused only when this is the *target* of a window capture — there is then no
 * identity to check against the blocklist. Do not use this helper to scan neighbouring windows
 * on a display: system chrome like the menu-bar strip often has a title and no owning app, and
 * `blockedWindowReason('')` would false-positive as "no title".
 */
function blockedWindowReason(windowTitle) {
    const title = (windowTitle ?? '').trim();
    if (!title)
        return 'That window has no title, so there is no way to tell what it is showing.';
    const label = blockedLabel(title);
    if (label) {
        return `That looks like ${label}. 1ShowcaseTool will not record a window that exists to display secrets.`;
    }
    return null;
}
/**
 * Whether a display or region capture may start, given what is on screen right now.
 *
 * Window capture is scoped by the framework, so a vault behind the target cannot reach the
 * stream. A display capture has no such protection: every window on that screen is in frame.
 * Refusing at start is worth doing even though it cannot cover a window opened later — most of
 * the damage this prevents is the Maker who simply forgot what was already open.
 *
 * Pattern match only. The empty-title refusal is for a chosen window target — macOS always
 * reports a strip titled "Menubar" with no owning application, and treating that as a vault
 * made every display recording refuse after the countdown.
 */
function blockedOnDisplayReason(visible) {
    for (const window of visible ?? []) {
        const label = blockedLabel(window.title ?? '') ?? blockedLabel(window.app ?? '');
        if (label) {
            const name = (window.app || window.title).trim() || label;
            return `${name} is open on that screen, and 1ShowcaseTool will not record a display showing an app that exists to display secrets. Close or move it, then try again.`;
        }
    }
    return null;
}
/**
 * What the Maker is told about the target they chose, in the UI, before they press record.
 *
 * Deliberately different sentences: a window capture really does carry a framework guarantee,
 * and saying the same thing about a display capture would be false comfort.
 */
function targetRiskNote(kind) {
    switch (kind) {
        case 'window':
            return 'Only this window is captured. Anything in front of it, behind it, or on another screen never reaches the recording.';
        case 'region':
            return 'Everything inside this region is captured, including any window that moves into it while you record. Mask anything sensitive before you export.';
        default:
            return 'Everything on this display is captured, including notifications and any window you switch to. Mask anything sensitive before you export.';
    }
}
/** A short human label for the recording target, used in the HUD and the library. */
function describeTarget(kind, name) {
    const trimmed = (name ?? '').trim();
    if (kind === 'window')
        return trimmed || 'Untitled window';
    if (kind === 'region')
        return trimmed ? `Region of ${trimmed}` : 'Screen region';
    return trimmed || 'Display';
}
/** Lowercase, alphanumerics and single dashes. Used to build the synthetic step URI. */
function slugifyWindowTitle(windowTitle) {
    const slug = (windowTitle ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return slug || 'window';
}
/**
 * How a machine step is addressed in the fields the guide schema already has.
 *
 * A desktop window has no URL, but `urlPattern` is a required non-empty string all the way
 * down the pipeline — the exporters, the preview, the video template and the generator prompt
 * all treat it as an opaque label. A synthetic `app://` URI keeps every one of them unchanged
 * and keeps SCHEMA_VERSION at 1, which the schema's own comment asks for. It also matches no
 * real page, which is the third of the three replay guards.
 */
function appUriFor(windowTitle) {
    return `app://${slugifyWindowTitle(windowTitle)}`;
}
/** True for a step address produced by the machine recorder. */
function isAppUri(value) {
    return typeof value === 'string' && value.startsWith('app://');
}
//# sourceMappingURL=machinePolicy.js.map