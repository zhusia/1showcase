"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.libraryOrganizationStore = exports.LibraryOrganizationStore = void 0;
const crypto_1 = require("crypto");
const db_1 = require("../db");
const libraryOrganization_1 = require("./libraryOrganization");
const itemKey = (kind, id) => `${kind}:${id}`;
/** Both kinds, so a bad value from a renderer cannot file something under a third one. */
function toKind(raw) {
    return raw === 'session' ? 'session' : 'guide';
}
class LibraryOrganizationStore {
    nodes() {
        const rows = (0, db_1.getDb)()
            .prepare(`SELECT id, parent_id, name, color, seq FROM library_folders`)
            .all();
        return rows.map((row) => ({
            id: row.id,
            parentId: row.parent_id,
            name: row.name,
            color: row.color,
            seq: row.seq,
        }));
    }
    /**
     * Everything the library screen needs, in one call.
     *
     * One round trip rather than five, because the tree, the chips and the per-row badges are
     * one view of one thing: fetching them separately would let the tree render a count that the
     * rows it is sitting above disagree with.
     */
    snapshot() {
        const db = (0, db_1.getDb)();
        const placementRows = db
            .prepare(`SELECT folder_id, item_kind, item_id FROM library_folder_items`)
            .all();
        const direct = new Map();
        const placement = {};
        for (const row of placementRows) {
            placement[itemKey(toKind(row.item_kind), row.item_id)] = row.folder_id;
            direct.set(row.folder_id, (direct.get(row.folder_id) ?? 0) + 1);
        }
        const tagRows = db.prepare(`SELECT id, name, color FROM library_tags`).all();
        const tagItemRows = db
            .prepare(`SELECT tag_id, item_kind, item_id FROM library_tag_items`)
            .all();
        const counts = new Map();
        const itemTags = {};
        const liveTagIds = new Set(tagRows.map((row) => row.id));
        for (const row of tagItemRows) {
            // A row pointing at a deleted tag is not counted and not reported — same treatment a
            // dangling collection row gets, rather than rendering as a chip with no name.
            if (!liveTagIds.has(row.tag_id))
                continue;
            counts.set(row.tag_id, (counts.get(row.tag_id) ?? 0) + 1);
            const key = itemKey(toKind(row.item_kind), row.item_id);
            (itemTags[key] ??= []).push(row.tag_id);
        }
        const tags = tagRows
            .map((row) => ({ id: row.id, name: row.name, color: row.color, count: counts.get(row.id) ?? 0 }))
            .sort((a, b) => a.name.localeCompare(b.name));
        const order = new Map(tags.map((tag, index) => [tag.id, index]));
        for (const key of Object.keys(itemTags)) {
            itemTags[key].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
        }
        /**
         * Counted against what exists, not by subtracting the filed rows from the total. An
         * unfiled item is one the library holds and no folder claims — deriving it from
         * `placementRows.length` would go wrong by exactly the number of stale rows, and report a
         * negative-looking gap the moment pruning missed one.
         */
        const totals = db
            .prepare(`SELECT (SELECT COUNT(*) FROM sessions s
                  WHERE NOT EXISTS (SELECT 1 FROM library_folder_items i
                                     WHERE i.item_kind = 'session' AND i.item_id = s.id))
              + (SELECT COUNT(*) FROM guides g
                  WHERE NOT EXISTS (SELECT 1 FROM library_folder_items i
                                     WHERE i.item_kind = 'guide' AND i.item_id = g.id)) AS n`)
            .get();
        return {
            folders: (0, libraryOrganization_1.summarizeFolders)(this.nodes(), direct),
            tags,
            placement,
            itemTags,
            unfiledCount: totals.n,
        };
    }
    // ------------------------------------------------------------------ folders
    /**
     * Create a project (no parent) or a folder inside one. The depth check runs before the
     * insert so a refusal leaves nothing behind.
     */
    createFolder(name, parentId) {
        const clean = (0, libraryOrganization_1.normalizeFolderName)(name) || (parentId ? 'New folder' : 'New project');
        const nodes = this.nodes();
        if (parentId) {
            const parent = nodes.find((node) => node.id === parentId);
            if (!parent)
                throw new Error('That project no longer exists.');
            // Reuse the move rule rather than restate the arithmetic: a folder created at a depth is
            // the same question as a folder moved to it, and two copies would eventually disagree.
            const refusal = (0, libraryOrganization_1.moveRefusal)([...nodes, { id: '__new__', parentId, name: clean, color: '', seq: 0 }], '__new__', parentId);
            if (refusal)
                throw new Error(refusal);
        }
        const id = (0, crypto_1.randomUUID)();
        const seq = ((0, db_1.getDb)()
            .prepare(`SELECT MAX(seq) AS m FROM library_folders WHERE parent_id IS ?`)
            .get(parentId)?.m ?? -1) + 1;
        (0, db_1.getDb)()
            .prepare(`INSERT INTO library_folders (id, parent_id, name, color, seq) VALUES (?, ?, ?, '', ?)`)
            .run(id, parentId, clean, seq);
        const created = this.snapshot().folders.find((folder) => folder.id === id);
        if (!created)
            throw new Error('The folder could not be created.');
        return created;
    }
    renameFolder(id, name, color) {
        const clean = (0, libraryOrganization_1.normalizeFolderName)(name);
        if (!clean)
            throw new Error('A folder needs a name.');
        (0, db_1.getDb)()
            .prepare(`UPDATE library_folders SET name = ?, color = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(clean, String(color ?? '').slice(0, 24), id);
    }
    /** Refuses the move rather than silently clamping it — see `moveRefusal` for the three reasons. */
    moveFolder(id, newParentId) {
        const nodes = this.nodes();
        const refusal = (0, libraryOrganization_1.moveRefusal)(nodes, id, newParentId);
        if (refusal)
            throw new Error(refusal);
        const seq = ((0, db_1.getDb)()
            .prepare(`SELECT MAX(seq) AS m FROM library_folders WHERE parent_id IS ?`)
            .get(newParentId)?.m ?? -1) + 1;
        (0, db_1.getDb)()
            .prepare(`UPDATE library_folders SET parent_id = ?, seq = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(newParentId, seq, id);
    }
    /**
     * Delete a folder and everything below it. **Content is never touched** — the recordings and
     * guides that were filed here become unfiled, exactly as they were before anyone organised
     * anything. Whole subtree in one transaction, so a folder can never outlive its parent and
     * strand its items in a project that no longer exists.
     */
    deleteFolder(id) {
        const db = (0, db_1.getDb)();
        const ids = (0, libraryOrganization_1.subtreeIds)(this.nodes(), id);
        if (!ids.length)
            return { unfiled: 0, folders: 0 };
        const marks = ids.map(() => '?').join(',');
        const run = db.transaction(() => {
            const affected = db
                .prepare(`SELECT COUNT(*) AS n FROM library_folder_items WHERE folder_id IN (${marks})`)
                .get(...ids);
            db.prepare(`DELETE FROM library_folder_items WHERE folder_id IN (${marks})`).run(...ids);
            db.prepare(`DELETE FROM library_folders WHERE id IN (${marks})`).run(...ids);
            return affected.n;
        });
        return { unfiled: run(), folders: ids.length };
    }
    /**
     * File items, or — with a null folder — unfile them. One statement per item rather than a
     * diff, and `ON CONFLICT` on the (kind, id) key is what moves an item rather than duplicating
     * it: the key already says an item has one home, so the upsert is that rule doing its job.
     */
    fileItems(items, folderId) {
        const db = (0, db_1.getDb)();
        if (folderId) {
            const exists = db.prepare(`SELECT 1 FROM library_folders WHERE id = ?`).get(folderId);
            if (!exists)
                throw new Error('That folder no longer exists.');
        }
        const insert = db.prepare(`INSERT INTO library_folder_items (folder_id, item_kind, item_id) VALUES (?, ?, ?)
       ON CONFLICT(item_kind, item_id) DO UPDATE SET folder_id = excluded.folder_id, added_at = datetime('now')`);
        const remove = db.prepare(`DELETE FROM library_folder_items WHERE item_kind = ? AND item_id = ?`);
        db.transaction(() => {
            for (const item of items) {
                const kind = toKind(item.kind);
                if (folderId)
                    insert.run(folderId, kind, item.id);
                else
                    remove.run(kind, item.id);
            }
        })();
    }
    // --------------------------------------------------------------------- tags
    /**
     * Find or create a tag by name. The lookup is on the lowercased name, matching the unique
     * index — so this is idempotent, and two items tagged `Onboarding` and `onboarding` land on
     * one tag rather than on two that render identically.
     */
    ensureTag(name) {
        const clean = (0, libraryOrganization_1.normalizeTagName)(name);
        if (!clean)
            throw new Error('A tag needs a name.');
        const db = (0, db_1.getDb)();
        const existing = db.prepare(`SELECT id, name, color FROM library_tags WHERE lower(name) = ?`).get((0, libraryOrganization_1.tagKey)(clean));
        if (existing) {
            const count = db.prepare(`SELECT COUNT(*) AS n FROM library_tag_items WHERE tag_id = ?`).get(existing.id);
            return { id: existing.id, name: existing.name, color: existing.color, count: count.n };
        }
        const id = (0, crypto_1.randomUUID)();
        db.prepare(`INSERT INTO library_tags (id, name, color) VALUES (?, ?, '')`).run(id, clean);
        return { id, name: clean, color: '', count: 0 };
    }
    renameTag(id, name, color) {
        const clean = (0, libraryOrganization_1.normalizeTagName)(name);
        if (!clean)
            throw new Error('A tag needs a name.');
        const db = (0, db_1.getDb)();
        const clash = db.prepare(`SELECT id FROM library_tags WHERE lower(name) = ? AND id != ?`).get((0, libraryOrganization_1.tagKey)(clean), id);
        // Refused rather than merged: merging two tags silently re-tags every item on both, and a
        // rename is not the place to ask for that.
        if (clash)
            throw new Error(`There is already a tag called ${clean}.`);
        db.prepare(`UPDATE library_tags SET name = ?, color = ? WHERE id = ?`).run(clean, String(color ?? '').slice(0, 24), id);
    }
    /** Deleting a tag removes the label, never the labelled. */
    deleteTag(id) {
        const db = (0, db_1.getDb)();
        db.transaction(() => {
            db.prepare(`DELETE FROM library_tag_items WHERE tag_id = ?`).run(id);
            db.prepare(`DELETE FROM library_tags WHERE id = ?`).run(id);
        })();
    }
    /**
     * Add or remove one tag across a set of items. `on` is explicit rather than a toggle, because
     * a toggle over a mixed selection — some tagged, some not — has no meaning the Maker could
     * have predicted from the button they pressed.
     */
    tagItems(items, tagId, on) {
        const db = (0, db_1.getDb)();
        const insert = db.prepare(`INSERT INTO library_tag_items (tag_id, item_kind, item_id) VALUES (?, ?, ?)
       ON CONFLICT(tag_id, item_kind, item_id) DO NOTHING`);
        const remove = db.prepare(`DELETE FROM library_tag_items WHERE tag_id = ? AND item_kind = ? AND item_id = ?`);
        db.transaction(() => {
            for (const item of items) {
                const kind = toKind(item.kind);
                if (on)
                    insert.run(tagId, kind, item.id);
                else
                    remove.run(tagId, kind, item.id);
            }
        })();
    }
    /** Type a comma-separated list, get every tag applied. The entry point the row editor uses. */
    applyTagInput(items, raw) {
        const applied = (0, libraryOrganization_1.parseTagInput)(raw).map((name) => this.ensureTag(name));
        for (const tag of applied)
            this.tagItems(items, tag.id, true);
        return applied;
    }
    // ------------------------------------------------------------------ pruning
    /**
     * Called when a recording or guide is deleted, so nothing keeps a row pointing at something
     * that no longer exists — the same contract as `CollectionStore.pruneGuide`. Without it a
     * folder's count would include items that are gone, and a re-used id could inherit a
     * stranger's filing.
     */
    pruneItem(kind, id) {
        const db = (0, db_1.getDb)();
        db.prepare(`DELETE FROM library_folder_items WHERE item_kind = ? AND item_id = ?`).run(kind, id);
        db.prepare(`DELETE FROM library_tag_items WHERE item_kind = ? AND item_id = ?`).run(kind, id);
    }
    /**
     * Give a new guide the filing of the recording it came from.
     *
     * Called only on a guide's *first* save. A Maker who files a guide somewhere deliberately and
     * then re-generates it must not have that undone by a session that never moved — so this is
     * an inheritance at birth, not a rule that keeps re-asserting itself.
     */
    inheritFromSession(guideId, sessionId) {
        const db = (0, db_1.getDb)();
        const home = db
            .prepare(`SELECT folder_id FROM library_folder_items WHERE item_kind = 'session' AND item_id = ?`)
            .get(sessionId);
        if (home)
            this.fileItems([{ kind: 'guide', id: guideId }], home.folder_id);
        const tags = db
            .prepare(`SELECT tag_id FROM library_tag_items WHERE item_kind = 'session' AND item_id = ?`)
            .all(sessionId);
        for (const tag of tags)
            this.tagItems([{ kind: 'guide', id: guideId }], tag.tag_id, true);
    }
}
exports.LibraryOrganizationStore = LibraryOrganizationStore;
exports.libraryOrganizationStore = new LibraryOrganizationStore();
//# sourceMappingURL=LibraryOrganizationStore.js.map