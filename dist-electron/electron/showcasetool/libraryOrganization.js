"use strict";
/**
 * Projects, folders and tags — the two ways a library of recordings and guides gets kept.
 *
 * This module must never import `electron`, for the same reason `machinePolicy.ts` and
 * `entitlements.ts` do not: `verify:core` imports it from `dist-electron/` and exercises the
 * rules without booting an app. Everything here is pure string and tree logic; anything that
 * touches SQLite lives in `LibraryOrganizationStore.ts`.
 *
 * ## The three shapes, and why there are three
 *
 * - **A project is a root node; a folder is a node with a parent.** One table, one mechanism,
 *   and the two words the Maker already uses. A separate `projects` table would have meant
 *   every read written twice and a rename that could move a folder out of the only container
 *   it was allowed in.
 * - **An item has at most one folder.** That is what makes it a folder rather than a tag, and
 *   it is enforced by the primary key on `library_folder_items` — not by a check in a service
 *   that a second call site could forget. "Where does this live" has one answer.
 * - **A tag is many-to-many and cuts across the tree.** `needs-rerecord` is true of guides in
 *   four projects at once; filing is about where a thing lives, tagging is about what is true
 *   of it. Collapsing the two would force a Maker to pick which fact gets to be the hierarchy.
 *
 * Organisation is *library metadata and nothing else*. It is never written into the guide JSON,
 * so `SCHEMA_VERSION` is untouched and an exported guide carries no trace of how the machine it
 * came from happened to be arranged — the same rule that keeps a collection a join rather than
 * content.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TAG_NAME_MAX = exports.FOLDER_NAME_MAX = exports.MAX_DEPTH = void 0;
exports.normalizeFolderName = normalizeFolderName;
exports.normalizeTagName = normalizeTagName;
exports.tagKey = tagKey;
exports.parseTagInput = parseTagInput;
exports.subtreeIds = subtreeIds;
exports.depthOf = depthOf;
exports.pathOf = pathOf;
exports.moveRefusal = moveRefusal;
exports.summarizeFolders = summarizeFolders;
/** Root plus three levels of folder. Deep enough for real work, shallow enough to breadcrumb. */
exports.MAX_DEPTH = 4;
exports.FOLDER_NAME_MAX = 60;
exports.TAG_NAME_MAX = 32;
/** Control characters, including the newline that would let a name overlap the row below it. */
const CONTROL = /[\u0000-\u001f\u007f]/g;
/**
 * A folder name as it gets stored. Control characters are stripped rather than escaped — a
 * name is one line in a tree row, and a smuggled newline is a row that overlaps its neighbour
 * in every layout that renders the string raw.
 */
function normalizeFolderName(raw) {
    return String(raw ?? '')
        .replace(CONTROL, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, exports.FOLDER_NAME_MAX);
}
/**
 * A tag as it gets stored. A leading `#` is what people type and never what they mean, and
 * inner whitespace becomes a hyphen so `needs rerecord` and `needs-rerecord` cannot become two
 * tags that look identical in a chip row.
 */
function normalizeTagName(raw) {
    return String(raw ?? '')
        .replace(CONTROL, ' ')
        .replace(/^[#\s]+/, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, exports.TAG_NAME_MAX);
}
/**
 * The identity of a tag. Case is presentation — a Maker who types `Onboarding` after having
 * typed `onboarding` means the tag they already have, not a second one that sorts beside it.
 * The display name stays as first typed; only the key decides sameness.
 */
function tagKey(name) {
    return normalizeTagName(name).toLowerCase();
}
/** Split a comma or newline separated entry into distinct tags, in the order typed. */
function parseTagInput(raw) {
    const seen = new Set();
    const out = [];
    for (const part of String(raw ?? '').split(/[,\n]/)) {
        const name = normalizeTagName(part);
        if (!name)
            continue;
        const key = tagKey(name);
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(name);
    }
    return out;
}
/** Every id from `id` downward, `id` first. Used by move validation and subtree delete. */
function subtreeIds(nodes, id) {
    const childrenOf = new Map();
    for (const node of nodes) {
        if (!node.parentId)
            continue;
        const list = childrenOf.get(node.parentId);
        if (list)
            list.push(node.id);
        else
            childrenOf.set(node.parentId, [node.id]);
    }
    const out = [];
    const queue = [id];
    const guard = new Set();
    while (queue.length) {
        const next = queue.shift();
        // `moveRefusal` cannot create a cycle, but a hand-edited row must not hang the walk here.
        if (guard.has(next))
            continue;
        guard.add(next);
        out.push(next);
        queue.push(...(childrenOf.get(next) ?? []));
    }
    return out;
}
/**
 * How deep a node sits, counting a project as 0. Returns -1 for a broken chain (a parent that
 * no longer exists) so a caller can treat the node as orphaned rather than silently rooting it.
 */
function depthOf(nodes, id) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    let depth = 0;
    let current = byId.get(id);
    if (!current)
        return -1;
    while (current.parentId) {
        const parent = byId.get(current.parentId);
        if (!parent)
            return -1;
        depth += 1;
        if (depth > exports.MAX_DEPTH)
            return -1;
        current = parent;
    }
    return depth;
}
/** Ancestor names then this one, for a breadcrumb. */
function pathOf(nodes, id) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const out = [];
    let current = byId.get(id);
    let guard = 0;
    while (current && guard <= exports.MAX_DEPTH) {
        out.unshift(current.name);
        current = current.parentId ? byId.get(current.parentId) : undefined;
        guard += 1;
    }
    return out;
}
/**
 * Why a move is refused, or null if it is allowed. The first refusal is the one that matters:
 * dragging a project onto one of its own folders would detach the whole subtree from the tree
 * and leave every item in it unreachable from any root. Phrased as sentences because they are
 * shown to the Maker verbatim.
 */
function moveRefusal(nodes, id, newParentId) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const node = byId.get(id);
    if (!node)
        return 'That folder no longer exists.';
    if (newParentId === id)
        return 'A folder cannot be moved inside itself.';
    if (newParentId === null)
        return null; // Promoting anything to a project is always legal.
    const parent = byId.get(newParentId);
    if (!parent)
        return 'That destination no longer exists.';
    if (subtreeIds(nodes, id).includes(newParentId))
        return 'A folder cannot be moved inside one of its own folders.';
    const parentDepth = depthOf(nodes, newParentId);
    if (parentDepth < 0)
        return 'That destination is not attached to a project.';
    // The moving node brings its own subtree with it, so the check is against its deepest leaf.
    const ownDepth = depthOf(nodes, id);
    const deepest = subtreeIds(nodes, id).reduce((max, childId) => Math.max(max, depthOf(nodes, childId)), ownDepth);
    if (parentDepth + 1 + (deepest - ownDepth) > exports.MAX_DEPTH - 1) {
        return `Folders go ${exports.MAX_DEPTH} levels deep at most, and this move would go past that.`;
    }
    return null;
}
/**
 * Decorate a flat node list with depth, path and rolled-up counts, sorted for display:
 * siblings by their stored order then name, each parent immediately followed by its subtree.
 *
 * Computed here rather than in the renderer so there is one definition of what the tree looks
 * like. The renderer draws what this returns — it has no copy of the walk to drift from, which
 * is the same reason the studio's stage geometry lives in one module.
 */
function summarizeFolders(nodes, direct) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const childrenOf = new Map();
    for (const node of nodes) {
        // A node whose parent vanished is shown as a project rather than hidden — an orphaned
        // folder still holds items, and dropping it from the tree is how those get lost.
        const key = node.parentId && byId.has(node.parentId) ? node.parentId : null;
        const list = childrenOf.get(key);
        if (list)
            list.push(node);
        else
            childrenOf.set(key, [node]);
    }
    for (const list of childrenOf.values()) {
        list.sort((a, b) => a.seq - b.seq || a.name.localeCompare(b.name));
    }
    const out = [];
    const walk = (node, depth, trail) => {
        const path = [...trail, node.name];
        const index = out.length;
        const directCount = direct.get(node.id) ?? 0;
        out.push({ ...node, depth, path, directCount, totalCount: directCount });
        let total = directCount;
        for (const child of childrenOf.get(node.id) ?? [])
            total += walk(child, depth + 1, path);
        out[index].totalCount = total;
        return total;
    };
    for (const root of childrenOf.get(null) ?? [])
        walk(root, 0, []);
    return out;
}
//# sourceMappingURL=libraryOrganization.js.map