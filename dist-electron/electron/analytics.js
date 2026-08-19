"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initAnalytics = initAnalytics;
exports.getAnalyticsPrefs = getAnalyticsPrefs;
exports.setAnalyticsPrefs = setAnalyticsPrefs;
exports.trackEvent = trackEvent;
const main_1 = require("@aptabase/electron/main");
const db_1 = require("./db");
/**
 * Privacy-first anonymous usage analytics via Aptabase.
 *
 * Pattern mirrors the other StoicSoft desktop apps (1DevTool / 1MarketingTool):
 *   - `initialize()` must run before `app.whenReady()` — the SDK refuses later
 *   - nothing is sent until the user has both seen the first-run consent dialog
 *     and opted in
 *   - failures never break product paths
 */
const APTABASE_APP_KEY = 'A-US-6817641760';
const CONSENT_SHOWN_KEY = 'telemetryConsentShown';
const OPT_IN_KEY = 'telemetryOptIn';
let initialized = false;
/**
 * Calls Aptabase's `initialize()`. Must be invoked synchronously at module
 * load time, BEFORE `app.whenReady()` resolves — the SDK refuses to init
 * once `app.isReady()` is true and silently disables tracking.
 */
function initAnalytics() {
    if (initialized)
        return;
    try {
        (0, main_1.initialize)(APTABASE_APP_KEY);
        initialized = true;
    }
    catch (error) {
        if (process.env.NODE_ENV !== 'production') {
            console.warn('[analytics] Aptabase initialization failed:', error);
        }
    }
}
function readBoolSetting(key) {
    try {
        const row = (0, db_1.getDb)().prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
        if (!row)
            return false;
        // Accept both JSON booleans and the literal strings "true"/"false".
        if (row.value === 'true' || row.value === '1')
            return true;
        if (row.value === 'false' || row.value === '0')
            return false;
        try {
            return JSON.parse(row.value) === true;
        }
        catch {
            return false;
        }
    }
    catch {
        // DB not ready yet (very early boot) or corrupt row — never track by accident.
        return false;
    }
}
function writeBoolSetting(key, value) {
    (0, db_1.getDb)()
        .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(key, JSON.stringify(value));
}
function getAnalyticsPrefs() {
    return {
        consentShown: readBoolSetting(CONSENT_SHOWN_KEY),
        enabled: readBoolSetting(OPT_IN_KEY),
    };
}
/**
 * Persist the preference and return the stored value. Setting `enabled` also
 * stamps `consentShown`, because the Settings toggle is a decision either way
 * and the first-run dialog should never reappear after someone has chosen.
 */
function setAnalyticsPrefs(prefs) {
    if (prefs.consentShown !== undefined)
        writeBoolSetting(CONSENT_SHOWN_KEY, prefs.consentShown);
    if (prefs.enabled !== undefined) {
        writeBoolSetting(OPT_IN_KEY, prefs.enabled);
        // A Settings toggle is an explicit answer — never re-prompt after it.
        if (prefs.consentShown === undefined)
            writeBoolSetting(CONSENT_SHOWN_KEY, true);
    }
    return getAnalyticsPrefs();
}
function isOptedIn() {
    try {
        const prefs = getAnalyticsPrefs();
        return prefs.consentShown === true && prefs.enabled === true;
    }
    catch {
        return false;
    }
}
function trackEvent(name, props) {
    if (!initialized || !isOptedIn())
        return;
    if (process.env.NODE_ENV !== 'production') {
        console.log('[analytics:main]', name, props ?? '');
    }
    try {
        (0, main_1.trackEvent)(name, props);
    }
    catch {
        // Aptabase failures must never break the app.
    }
}
//# sourceMappingURL=analytics.js.map