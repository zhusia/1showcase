"use strict";
/**
 * BUILD_RELEASE_DATE reader — the offline half of the one-year updates rule.
 *
 * `scripts/stamp-build-date.mjs` writes `dist-electron/build-release-date.json` as part of
 * `npm run package`, and electron-builder ships `dist-electron/**` so it lands inside the asar.
 * A dev build, or one made with plain `npm run build`, has no stamp — and that is deliberate:
 * callers treat null as "no window constraint" (epoch), because someone building from source must
 * never lose Pro to a missing file.
 *
 * The consequence worth knowing: an unstamped build can never *deny* Pro for an expired updates
 * window. Only released builds enforce the window, which is the only place it means anything.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBuildReleaseDate = getBuildReleaseDate;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
let cached;
function getBuildReleaseDate() {
    if (cached !== undefined)
        return cached;
    // Test and dev override.
    const fromEnv = process.env.ONESHOWCASETOOL_BUILD_RELEASE_DATE;
    if (fromEnv) {
        const d = new Date(fromEnv);
        cached = Number.isNaN(d.getTime()) ? null : d;
        return cached;
    }
    /**
     * Compiled location: tsc mirrors the source tree, so this file runs from
     * `dist-electron/electron/entitlement/` and the stamp sits two levels up at the root of the
     * compiled output.
     */
    try {
        const stampPath = node_path_1.default.join(__dirname, '..', '..', 'build-release-date.json');
        const parsed = JSON.parse((0, node_fs_1.readFileSync)(stampPath, 'utf8'));
        const d = parsed.releaseDate ? new Date(parsed.releaseDate) : null;
        cached = d && !Number.isNaN(d.getTime()) ? d : null;
    }
    catch {
        cached = null;
    }
    return cached;
}
//# sourceMappingURL=buildReleaseDate.js.map