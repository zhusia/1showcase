"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEV_PORT_DEFAULT = void 0;
exports.devHandoffFile = devHandoffFile;
exports.resolveDevServer = resolveDevServer;
exports.devServerUrl = devServerUrl;
exports.devServerWarning = devServerWarning;
const electron_1 = require("electron");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/**
 * Where the dev renderer is — discovered, never assumed.
 *
 * ## Why this file exists
 *
 * Main used to load a hardcoded `http://localhost:5273`, and Vite used `strictPort` so the two
 * could not disagree. That traded one failure for another: any other process holding 5273 — a stale
 * server from a sibling checkout, an `ssh -L 5273:127.0.0.1:5273` forward from another machine
 * running this same app — stopped `npm run dev` dead, and *worse*, when it won the race main happily
 * loaded it. The window came up looking perfectly normal while serving somebody else's source, so
 * local edits did nothing and the only symptom was "my change had no effect".
 *
 * So Vite now takes the next free port and writes down which one it took, and this module reads
 * that note and **verifies the server is this checkout** before anything loads from it. Two
 * independent checks, because neither is sufficient alone: the note says where to look, and
 * `/__dev-root` proves what answered is ours.
 *
 * ## Why the answer is cached
 *
 * Three windows load the renderer — the main window, the recording HUD, and the region overlay —
 * and the last two are created in the middle of a capture, where a second round of HTTP probes is
 * both pointless and badly timed. Main resolves once at startup; they read the cache.
 */
/** Vite's first choice. It moves up from here when the port is taken. */
exports.DEV_PORT_DEFAULT = 5273;
/** In dev, `__dirname` is `dist-electron/electron`; both of these walk out to the checkout root. */
function projectRoot() {
    const root = path_1.default.join(__dirname, '../..');
    try {
        return fs_1.default.realpathSync(root);
    }
    catch {
        return path_1.default.resolve(root);
    }
}
function samePath(a, b) {
    // Windows paths differ in case without differing at all.
    const normalize = (value) => (process.platform === 'win32' ? path_1.default.resolve(value).toLowerCase() : path_1.default.resolve(value));
    return normalize(a) === normalize(b);
}
/**
 * The note Vite leaves behind, inside a gitignored directory in the checkout it belongs to. A file
 * rather than a fixed port, because the whole point is that the port is not fixed; per-checkout
 * rather than in a temp directory, because two checkouts running at once must not overwrite each
 * other's answer.
 */
function devHandoffFile(root = projectRoot()) {
    return path_1.default.join(root, '.local-data', 'dev-server.json');
}
function readHandoff() {
    try {
        return JSON.parse(fs_1.default.readFileSync(devHandoffFile(), 'utf8'));
    }
    catch {
        return null;
    }
}
async function askPort(port, mine) {
    try {
        const response = await fetch(`http://localhost:${port}/__dev-root`, { signal: AbortSignal.timeout(1500) });
        const served = response.ok ? (await response.text()).trim() : '';
        // A path is a claim about a checkout; an HTML body is a different app answering a route it
        // does not know. Either way something is listening, which is what the caller has to act on.
        if (served && !served.startsWith('<'))
            return samePath(served, mine) ? { kind: 'ours' } : { kind: 'foreign', root: served };
        return { kind: 'foreign', root: null };
    }
    catch {
        return { kind: 'silent' };
    }
}
let resolved = null;
let problem = { kind: 'absent' };
/**
 * Find this checkout's dev server, or explain why there isn't one.
 *
 * The handoff is checked first, then the default port — the second case covers someone running
 * `vite` and `electron .` in two terminals, where the note exists but is from an older run, or
 * where it was never written because the server predates this mechanism.
 */
async function resolveDevServer() {
    const mine = projectRoot();
    const candidates = [];
    const handoff = readHandoff();
    if (handoff?.port)
        candidates.push(handoff.port);
    if (!candidates.includes(exports.DEV_PORT_DEFAULT))
        candidates.push(exports.DEV_PORT_DEFAULT);
    let mismatch = { kind: 'absent' };
    for (const port of candidates) {
        const answer = await askPort(port, mine);
        if (answer.kind === 'ours') {
            resolved = { url: `http://localhost:${port}`, port };
            problem = { kind: 'absent' };
            return { server: resolved, problem };
        }
        // Something is there and it is not us. Remember the first one, so the warning can name it.
        if (answer.kind === 'foreign' && mismatch.kind === 'absent')
            mismatch = { kind: 'mismatch', port, root: answer.root };
    }
    resolved = null;
    problem = mismatch;
    return { server: null, problem };
}
/**
 * The resolved dev URL, or null. Synchronous on purpose: the HUD and the region overlay are opened
 * mid-capture and must not wait on a network probe to show themselves.
 */
function devServerUrl(hash) {
    if (electron_1.app.isPackaged || !resolved)
        return null;
    return hash ? `${resolved.url}/#${hash}` : resolved.url;
}
/** What to tell the developer when the dev server was not used. Empty when it was. */
function devServerWarning() {
    if (resolved)
        return [];
    const lines = ['[showcasetool] this window is the LAST BUILT renderer, not your source. Nothing you edit will appear.'];
    if (problem.kind === 'mismatch') {
        // Naming what is there is the whole point: "port busy" sends you hunting, "1AIVault is on it"
        // does not. `npm run dev` sidesteps this entirely by taking the next free port instead.
        lines.push(`[showcasetool] port ${problem.port} is answering, but it is not this checkout` +
            (problem.root ? ` — it serves ${problem.root}.` : ' — it is another app or a forwarded port.'), '[showcasetool] Use npm run dev, which takes the next free port and tells this process where it went.');
    }
    else {
        lines.push('[showcasetool] no dev server answered. Start Vite (npm run dev) and relaunch.');
    }
    return lines;
}
//# sourceMappingURL=devServer.js.map