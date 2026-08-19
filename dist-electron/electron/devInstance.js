"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEV_USERDATA_SLOTS = void 0;
exports.isolatedUserDataPath = isolatedUserDataPath;
exports.isolatedUserDataCandidates = isolatedUserDataCandidates;
const path_1 = __importDefault(require("path"));
/**
 * Sibling userData folders an unpackaged process walks when the shipped lock is already held.
 *
 * The single-instance lock follows the userData directory, not the source tree — so a packaged
 * 1ShowcaseTool (or another checkout) sitting on `Application Support/1ShowcaseTool` makes
 * `npm run dev` exit 0 and `concurrently -k` tear Vite down with it. These siblings are the
 * equivalent of Vite walking off 5273: same product, different lock, different SQLite file.
 * Two processes must never share a database.
 */
exports.DEV_USERDATA_SLOTS = 8;
/** `1ShowcaseTool-dev`, then `1ShowcaseTool-dev-2` … `1ShowcaseTool-dev-8`. Never the shipped path. */
function isolatedUserDataPath(shipped, slot) {
    const parent = path_1.default.dirname(shipped);
    const name = path_1.default.basename(shipped);
    return path_1.default.join(parent, slot <= 1 ? `${name}-dev` : `${name}-dev-${slot}`);
}
function isolatedUserDataCandidates(shipped, slots = exports.DEV_USERDATA_SLOTS) {
    const out = [];
    for (let n = 1; n <= slots; n++)
        out.push(isolatedUserDataPath(shipped, n));
    return out;
}
//# sourceMappingURL=devInstance.js.map