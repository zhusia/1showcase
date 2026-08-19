"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectionStore = exports.CollectionStore = void 0;
const crypto_1 = require("crypto");
const db_1 = require("../db");
const GuideStore_1 = require("./GuideStore");
class CollectionStore {
    create(title, intent = '') {
        const id = (0, crypto_1.randomUUID)();
        (0, db_1.getDb)()
            .prepare(`INSERT INTO collections (id, title, intent) VALUES (?, ?, ?)`)
            .run(id, title.trim() || 'Untitled collection', intent.trim());
        return { id, title: title.trim() || 'Untitled collection', intent: intent.trim(), guideCount: 0, updatedAt: new Date().toISOString() };
    }
    rename(id, title, intent) {
        (0, db_1.getDb)()
            .prepare(`UPDATE collections SET title = ?, intent = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(title.trim() || 'Untitled collection', intent.trim(), id);
    }
    /** Deleting a collection is a grouping change, never a content one — guides are untouched. */
    delete(id) {
        const db = (0, db_1.getDb)();
        db.prepare(`DELETE FROM guide_collection_items WHERE collection_id = ?`).run(id);
        db.prepare(`DELETE FROM collections WHERE id = ?`).run(id);
    }
    list() {
        const rows = (0, db_1.getDb)().prepare(`SELECT * FROM collections ORDER BY updated_at DESC`).all();
        const counts = (0, db_1.getDb)()
            .prepare(`SELECT collection_id, COUNT(*) AS n FROM guide_collection_items GROUP BY collection_id`)
            .all();
        const byId = new Map(counts.map((c) => [c.collection_id, c.n]));
        return rows.map((row) => ({
            id: row.id,
            title: row.title,
            intent: row.intent,
            guideCount: byId.get(row.id) ?? 0,
            updatedAt: row.updated_at,
        }));
    }
    get(id) {
        const row = (0, db_1.getDb)().prepare(`SELECT * FROM collections WHERE id = ?`).get(id);
        if (!row)
            return null;
        const guides = this.guidesIn(id);
        return {
            id: row.id,
            title: row.title,
            intent: row.intent,
            guideCount: guides.length,
            updatedAt: row.updated_at,
            guides: guides.map((guide) => ({
                id: guide.id,
                title: guide.title,
                stepCount: guide.steps.length,
                language: guide.language,
            })),
        };
    }
    /**
     * Resolved guides in their collection order. A row whose guide has since been deleted is
     * pruned on read rather than left to render as a gap — the join is the only thing keeping
     * them associated, so a dangling row has no meaning.
     */
    guidesIn(collectionId) {
        const rows = (0, db_1.getDb)()
            .prepare(`SELECT guide_id, seq FROM guide_collection_items WHERE collection_id = ? ORDER BY seq ASC`)
            .all(collectionId);
        const out = [];
        const dangling = [];
        for (const row of rows) {
            const guide = GuideStore_1.guideStore.get(row.guide_id);
            if (guide)
                out.push(guide);
            else
                dangling.push(row.guide_id);
        }
        if (dangling.length) {
            const stmt = (0, db_1.getDb)().prepare(`DELETE FROM guide_collection_items WHERE collection_id = ? AND guide_id = ?`);
            for (const id of dangling)
                stmt.run(collectionId, id);
        }
        return out;
    }
    /** Idempotent: adding a guide already in the collection just moves it to the end. */
    add(collectionId, guideId) {
        const db = (0, db_1.getDb)();
        const next = (db.prepare(`SELECT MAX(seq) AS m FROM guide_collection_items WHERE collection_id = ?`).get(collectionId)
            ?.m ?? -1) + 1;
        db.prepare(`INSERT INTO guide_collection_items (collection_id, guide_id, seq) VALUES (?, ?, ?)
       ON CONFLICT(collection_id, guide_id) DO UPDATE SET seq = excluded.seq`).run(collectionId, guideId, next);
        this.touch(collectionId);
    }
    remove(collectionId, guideId) {
        (0, db_1.getDb)().prepare(`DELETE FROM guide_collection_items WHERE collection_id = ? AND guide_id = ?`).run(collectionId, guideId);
        this.touch(collectionId);
    }
    /** Whole-order write, so a drag reorder is one statement set rather than a diff. */
    reorder(collectionId, guideIds) {
        const db = (0, db_1.getDb)();
        const stmt = db.prepare(`UPDATE guide_collection_items SET seq = ? WHERE collection_id = ? AND guide_id = ?`);
        guideIds.forEach((guideId, index) => stmt.run(index, collectionId, guideId));
        this.touch(collectionId);
    }
    /** Called when a guide is deleted, so no collection keeps a row pointing at nothing. */
    pruneGuide(guideId) {
        (0, db_1.getDb)().prepare(`DELETE FROM guide_collection_items WHERE guide_id = ?`).run(guideId);
    }
    touch(collectionId) {
        (0, db_1.getDb)().prepare(`UPDATE collections SET updated_at = datetime('now') WHERE id = ?`).run(collectionId);
    }
}
exports.CollectionStore = CollectionStore;
exports.collectionStore = new CollectionStore();
//# sourceMappingURL=CollectionStore.js.map