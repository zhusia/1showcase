"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.dataDir = dataDir;
exports.screenshotDir = screenshotDir;
exports.getDb = getDb;
exports.prepared = prepared;
exports.closeDb = closeDb;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
let db = null;
/** Where sessions, guides, and the screenshot store live. */
function dataDir() {
    const dir = path_1.default.join(electron_1.app.getPath('userData'), 'showcasetool');
    if (!fs_1.default.existsSync(dir))
        fs_1.default.mkdirSync(dir, { recursive: true });
    return dir;
}
function screenshotDir() {
    const dir = path_1.default.join(dataDir(), 'screenshots');
    if (!fs_1.default.existsSync(dir))
        fs_1.default.mkdirSync(dir, { recursive: true });
    return dir;
}
function hasColumn(database, table, column) {
    const rows = database.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some((r) => r.name === column);
}
/**
 * Migrations have no user_version counter on purpose — same rule as the rest of the
 * suite. Every statement must be additive and idempotent: CREATE TABLE IF NOT EXISTS,
 * or guard with hasColumn() before ALTER TABLE ADD COLUMN. Never drop, never rewrite.
 */
function migrate(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT 'recording',
      started_at        TEXT NOT NULL,
      stopped_at        TEXT,
      redaction_ack_at  TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS session_steps (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      seq           INTEGER NOT NULL,
      kind          TEXT NOT NULL,
      url           TEXT NOT NULL DEFAULT '',
      url_pattern   TEXT NOT NULL DEFAULT '',
      page_title    TEXT NOT NULL DEFAULT '',
      selectors     TEXT NOT NULL DEFAULT '[]',
      a11y          TEXT NOT NULL DEFAULT '{}',
      value         TEXT,
      value_masked  INTEGER NOT NULL DEFAULT 0,
      placeholder   TEXT,
      viewport      TEXT NOT NULL DEFAULT '{}',
      screenshot    TEXT,
      full_page     TEXT,
      keystrokes    TEXT NOT NULL DEFAULT '[]',
      warnings      TEXT NOT NULL DEFAULT '[]',
      dropped       INTEGER NOT NULL DEFAULT 0,
      captured_at   TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_session_steps_session ON session_steps(session_id, seq);

    CREATE TABLE IF NOT EXISTS redaction_rules (
      id         TEXT PRIMARY KEY,
      scope      TEXT NOT NULL DEFAULT 'project',
      kind       TEXT NOT NULL,
      pattern    TEXT NOT NULL,
      placeholder TEXT NOT NULL DEFAULT '<REDACTED>',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    /*
      Which project rules actually fired, on which session. The manifest claims to list what was
      redacted *here*, and by the time it is built the evidence is gone — a fired rule has already
      replaced its pattern with the placeholder, so nothing can be re-derived by matching. Recorded
      at apply time instead.

      The placeholder is snapshotted rather than joined, so deleting a rule cannot rewrite the
      history of a recording it already redacted. The pattern is deliberately *not* stored: the
      manifest labels a hit by its placeholder, so a second plaintext copy of the value the rule
      exists to destroy would be one nobody reads.
    */
    CREATE TABLE IF NOT EXISTS redaction_rule_hits (
      session_id  TEXT NOT NULL,
      rule_id     TEXT NOT NULL,
      placeholder TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, rule_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS guides (
      id            TEXT PRIMARY KEY,
      session_id    TEXT,
      title         TEXT NOT NULL DEFAULT '',
      mode          TEXT NOT NULL DEFAULT 'standalone',
      schema_version INTEGER NOT NULL DEFAULT 1,
      json          TEXT NOT NULL,
      transport     TEXT NOT NULL DEFAULT '',
      generated_at  TEXT NOT NULL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS guide_progress (
      guide_id    TEXT NOT NULL,
      step_id     TEXT NOT NULL,
      state       TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (guide_id, step_id)
    );

    /**
     * Collections (docs/competitor-features.md §2.6). Scribe calls these Pages, Supademo calls
     * them Showcase; both are a hosted grouping. Ours is a local join, so a collection is two
     * tables and an index page rather than a service.
     *
     * guide_collection_items cascades on delete in spirit but not by constraint — the store
     * prunes on guide delete instead, because adding a foreign key to an existing table is not
     * an additive migration and this schema has no version counter (see the note above).
     *
     * (No backticks in this comment: it sits inside a template literal.)
     */
    CREATE TABLE IF NOT EXISTS collections (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT '',
      intent      TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS guide_collection_items (
      collection_id TEXT NOT NULL,
      guide_id      TEXT NOT NULL,
      seq           INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (collection_id, guide_id)
    );

    /**
     * Projects, folders and tags — how a Maker keeps a library once it stops fitting on one
     * screen. The rules and the tree maths live in showcasetool/libraryOrganization.ts; these
     * are the four tables they run over.
     *
     * A row with parent_id NULL is a *project*; a row with a parent is a *folder* inside one.
     * One table rather than two, because a project and a folder differ in where they sit and
     * in nothing else — two tables would have meant every read written twice.
     *
     * None of this is ever written into a guide's JSON. Organisation is local library
     * metadata, so SCHEMA_VERSION is untouched and an exported guide carries no trace of how
     * the machine it came from happened to be arranged.
     *
     * (No backticks in this comment: it sits inside a template literal.)
     */
    CREATE TABLE IF NOT EXISTS library_folders (
      id          TEXT PRIMARY KEY,
      parent_id   TEXT,
      name        TEXT NOT NULL DEFAULT '',
      color       TEXT NOT NULL DEFAULT '',
      seq         INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    /**
     * Where one recording or guide is filed. The primary key is (item_kind, item_id) and not
     * (folder_id, item_kind, item_id): an item has at most one home, and that is the whole
     * difference between a folder and a tag. Enforcing it in the key means no service, and no
     * later call site, can produce an item that is in two folders at once.
     *
     * No foreign key to sessions or guides, for the same reason guide_collection_items has
     * none: adding one to an existing table is not an additive migration, and this schema has
     * no version counter. The stores prune on delete instead.
     */
    CREATE TABLE IF NOT EXISTS library_folder_items (
      folder_id   TEXT NOT NULL,
      item_kind   TEXT NOT NULL,
      item_id     TEXT NOT NULL,
      added_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (item_kind, item_id)
    );

    /**
     * A tag is a name and a colour. Its identity is the *lowercased* name — a Maker who types
     * Onboarding having already typed onboarding means the tag they have, not a second one
     * that sorts beside it — so the unique index is on lower(name) while the stored name keeps
     * whatever case it was first given.
     */
    CREATE TABLE IF NOT EXISTS library_tags (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      color       TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS library_tag_items (
      tag_id     TEXT NOT NULL,
      item_kind  TEXT NOT NULL,
      item_id    TEXT NOT NULL,
      added_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tag_id, item_kind, item_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS studio_snapshots (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      name         TEXT NOT NULL,
      project_json TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS export_presets (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      settings_json TEXT NOT NULL
    );

    /**
     * The latest health-check report per guide: which steps' anchors still resolved when the
     * Maker last walked the flow in check mode. Report-only, like the guide audit — nothing
     * here ever edits the guide, and deleting the row loses nothing but a diagnosis.
     */
    CREATE TABLE IF NOT EXISTS guide_health (
      guide_id    TEXT PRIMARY KEY,
      checked_at  TEXT NOT NULL,
      report      TEXT NOT NULL DEFAULT '[]'
    );

    /**
     * Re-shot step screenshots waiting for review. A pending row is a *proposal*: the guide
     * still points at its old, acknowledged screenshot, and every export reads the guide —
     * so unreviewed pixels are structurally unreachable from any export path. Approving is
     * the review; it swaps the step's pointer and deletes the row.
     */
    CREATE TABLE IF NOT EXISTS guide_refreshes (
      guide_id        TEXT NOT NULL,
      step_id         TEXT NOT NULL,
      old_screenshot  TEXT NOT NULL DEFAULT '',
      new_screenshot  TEXT NOT NULL,
      target_rect     TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (guide_id, step_id)
    );
  `);
    // Additive guards for columns introduced after the initial CREATE above.
    if (!hasColumn(database, 'sessions', 'prompt')) {
        database.exec(`ALTER TABLE sessions ADD COLUMN prompt TEXT NOT NULL DEFAULT ''`);
    }
    if (!hasColumn(database, 'sessions', 'audience')) {
        database.exec(`ALTER TABLE sessions ADD COLUMN audience TEXT NOT NULL DEFAULT ''`);
    }
    if (!hasColumn(database, 'session_steps', 'outputs')) {
        database.exec(`ALTER TABLE session_steps ADD COLUMN outputs TEXT NOT NULL DEFAULT '[]'`);
    }
    /** Chapter title and branch declarations, both Maker-authored during the review pass. */
    if (!hasColumn(database, 'session_steps', 'chapter')) {
        database.exec(`ALTER TABLE session_steps ADD COLUMN chapter TEXT NOT NULL DEFAULT ''`);
    }
    if (!hasColumn(database, 'session_steps', 'branches')) {
        database.exec(`ALTER TABLE session_steps ADD COLUMN branches TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!hasColumn(database, 'session_steps', 'capture_error')) {
        database.exec(`ALTER TABLE session_steps ADD COLUMN capture_error TEXT`);
    }
    // Where the clicked element sits inside the step screenshot, so an arrow can be auto-placed.
    if (!hasColumn(database, 'session_steps', 'target_rect')) {
        database.exec(`ALTER TABLE session_steps ADD COLUMN target_rect TEXT`);
    }
    // The Generation step's customisation choices, kept per session so they survive a re-run.
    if (!hasColumn(database, 'sessions', 'customize')) {
        database.exec(`ALTER TABLE sessions ADD COLUMN customize TEXT NOT NULL DEFAULT '{}'`);
    }
    /**
     * Which recorder produced this session — 'browser' (the extension) or 'machine' (a desktop
     * window). Everything written before this column existed came from the extension, so the
     * default is the honest answer rather than a placeholder.
     */
    if (!hasColumn(database, 'sessions', 'source')) {
        database.exec(`ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'browser'`);
    }
    // The single window a machine recording was locked to, for its whole duration.
    if (!hasColumn(database, 'sessions', 'target_window')) {
        database.exec(`ALTER TABLE sessions ADD COLUMN target_window TEXT NOT NULL DEFAULT ''`);
    }
    /**
     * How a machine session was captured (docs/real-recorder-plan.md §6). Deliberately *not* a
     * third value of `source`: everything keyed on `source = 'machine'` — no Layer 1, no replay,
     * the stricter gate — is identically true of a video recording, and a third source would fork
     * every one of those branches for nothing. 'shots' is the hotkey recorder that came first.
     */
    if (!hasColumn(database, 'sessions', 'capture_mode')) {
        database.exec(`ALTER TABLE sessions ADD COLUMN capture_mode TEXT NOT NULL DEFAULT 'shots'`);
    }
    // Relative path to the recorded movie, like screenshots. Empty for a 'shots' session.
    if (!hasColumn(database, 'sessions', 'media_path')) {
        database.exec(`ALTER TABLE sessions ADD COLUMN media_path TEXT NOT NULL DEFAULT ''`);
    }
    /**
     * 'raw' | 'burned' | 'swept'. The footage is unredacted as captured, so this is what stops a
     * raw file leaving the machine: an export is only ever produced by the mask burn, which
     * composites opaque fills into new frames and writes 'burned'. A 'raw' recording has no path
     * out of the app, and one nobody came back to review is deleted after seven days ('swept').
     */
    if (!hasColumn(database, 'sessions', 'media_state')) {
        database.exec(`ALTER TABLE sessions ADD COLUMN media_state TEXT NOT NULL DEFAULT ''`);
    }
    /**
     * The studio project for a video recording: trim, speed, camera keyframes, cursor treatment,
     * background and mask rectangles (electron/showcasetool/studio.ts).
     *
     * It is all *description* — the captured movie is never edited in place, so every setting is
     * reversible right up until the export burns the masks into new pixels. Stored beside the
     * session config for the same reason `customize` is: none of it is a secret, and it has to
     * survive re-opening a recording days later.
     */
    if (!hasColumn(database, 'sessions', 'studio')) {
        database.exec(`ALTER TABLE sessions ADD COLUMN studio TEXT NOT NULL DEFAULT '{}'`);
    }
    /**
     * Mask entries that could not be read back, kept verbatim (electron/showcasetool/studio.ts).
     *
     * Its own column, deliberately **not** a field inside `studio`: the editor autosaves a complete
     * project every 400 ms, so anything living in that blob is renderer-writable and one round trip
     * would erase it. A dropped mask is a region that is silently no longer redacted, and the export
     * gate refuses while this is non-empty — so the evidence has to be somewhere a renderer bug
     * cannot reach. See §7.3 of docs/cinematic_video.md.
     */
    if (!hasColumn(database, 'sessions', 'studio_quarantine')) {
        database.exec(`ALTER TABLE sessions ADD COLUMN studio_quarantine TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!hasColumn(database, 'session_steps', 'window_title')) {
        database.exec(`ALTER TABLE session_steps ADD COLUMN window_title TEXT NOT NULL DEFAULT ''`);
    }
    // What the Maker typed in the capture HUD for this step. The strongest signal generation gets.
    if (!hasColumn(database, 'session_steps', 'note')) {
        database.exec(`ALTER TABLE session_steps ADD COLUMN note TEXT NOT NULL DEFAULT ''`);
    }
    /**
     * Whether the overlay may drive this guide. A machine recording yields pixel coordinates,
     * which cannot anchor an overlay on a page whose layout moves (PRD §5) — so guides made
     * from one are never offered for replay. Stored rather than derived so that deleting the
     * session cannot turn a machine guide back into a replayable one.
     */
    if (!hasColumn(database, 'guides', 'replayable')) {
        database.exec(`ALTER TABLE guides ADD COLUMN replayable INTEGER NOT NULL DEFAULT 1`);
    }
    /**
     * Which destructive pixel edits the Maker applied to this step's screenshot — a JSON set of
     * 'paint' and 'crop'. It is the only trace either one leaves: both overwrite the stored PNG in
     * place, so afterwards nothing distinguishes a painted frame from one that never needed it, and
     * the published manifest could not report the redaction that a machine recording depends on
     * most. Recorded at the moment of the overwrite, for the same reason a rule hit is.
     *
     * A set rather than a log: how many times a Maker painted a frame is not something a reader of
     * the guide can verify or act on, and counting invites reading the number as a severity.
     */
    if (!hasColumn(database, 'session_steps', 'pixel_edits')) {
        database.exec(`ALTER TABLE session_steps ADD COLUMN pixel_edits TEXT NOT NULL DEFAULT '[]'`);
    }
    /** Reversible screenshot artwork created from the review toolbar. */
    if (!hasColumn(database, 'session_steps', 'annotation_project')) {
        database.exec(`ALTER TABLE session_steps ADD COLUMN annotation_project TEXT`);
    }
    /** Maker-authored shortcuts/type labels for a future guide or video overlay. */
    if (!hasColumn(database, 'session_steps', 'keystrokes')) {
        database.exec(`ALTER TABLE session_steps ADD COLUMN keystrokes TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!hasColumn(database, 'session_steps', 'alt_selectors')) {
        database.exec(`ALTER TABLE session_steps ADD COLUMN alt_selectors TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!hasColumn(database, 'sessions', 'assessments')) {
        database.exec(`ALTER TABLE sessions ADD COLUMN assessments TEXT NOT NULL DEFAULT '[]'`);
    }
    /**
     * Indexes for the clauses the stores actually run. All additive and idempotent, like every
     * statement above. The guide_collection_items one matters most: the PK is
     * (collection_id, guide_id), so the prune-by-guide on every guide delete was a table scan.
     */
    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_guides_updated ON guides(updated_at);
    CREATE INDEX IF NOT EXISTS idx_collection_items_guide ON guide_collection_items(guide_id);
    CREATE INDEX IF NOT EXISTS idx_session_steps_dropped ON session_steps(session_id, dropped);

    /*
      The organisation tables. The folder_items PK is (item_kind, item_id), so counting a
      folder's contents — which the tree does for every row on every refresh — would otherwise
      be a scan. Same for pruning a tag's rows when the tag is deleted.

      lower(name) rather than name: the index IS the case-insensitive uniqueness rule, so that
      two spellings of one tag cannot both be inserted by two writes that each looked first.
    */
    CREATE INDEX IF NOT EXISTS idx_library_folders_parent ON library_folders(parent_id, seq);
    CREATE INDEX IF NOT EXISTS idx_library_folder_items_folder ON library_folder_items(folder_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_library_tags_name ON library_tags(lower(name));
    CREATE INDEX IF NOT EXISTS idx_library_tag_items_item ON library_tag_items(item_kind, item_id);
  `);
}
function getDb() {
    if (db)
        return db;
    db = new better_sqlite3_1.default(path_1.default.join(dataDir(), 'showcasetool.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
    return db;
}
/**
 * A memoized prepare. better-sqlite3 does not cache statements, so every `getDb().prepare(...)`
 * pays parse-and-plan again — cheap once, real inside the per-step loops. Statements belong to
 * their Database instance, so the cache empties whenever the handle closes.
 */
const statements = new Map();
function prepared(sql) {
    let statement = statements.get(sql);
    if (!statement) {
        statement = getDb().prepare(sql);
        statements.set(sql, statement);
    }
    return statement;
}
function closeDb() {
    statements.clear();
    db?.close();
    db = null;
}
//# sourceMappingURL=index.js.map