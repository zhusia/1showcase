"use strict";
/**
 * The entitlement gate's IO wrapper — what turns the pure decision in gate.ts into the thing
 * LicenseService consults.
 *
 * It memoises the hardware device hash (one ioreg/reg/machine-id read per run), verifies the
 * cached signed entitlement, classifies the last exchange, persists the grace bookkeeping, and
 * LATCHES the session grant so a mid-session refresh can upgrade free → Pro but never downgrades
 * Pro → free under a running app. A downgrade takes effect on the next boot, because pulling a
 * feature out from under someone mid-export is a worse bug than a few hours of grace.
 *
 * Fail-safe throughout: any throw, any unreadable value, any absent input degrades to the stored
 * boolean. Kill switch: ONESHOWCASETOOL_DISABLE_ENTITLEMENT_GATE=1.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENTITLEMENT_GATE_ENABLED = void 0;
exports.isEntitlementGateEnabled = isEntitlementGateEnabled;
exports.cacheKeyMatchesStored = cacheKeyMatchesStored;
exports.createEntitlementGate = createEntitlementGate;
const verify_1 = require("./verify");
const deviceHash_1 = require("./deviceHash");
const publicKey_1 = require("./publicKey");
const buildReleaseDate_1 = require("./buildReleaseDate");
const gate_1 = require("./gate");
/**
 * The master switch. `true` makes the cryptographic verdict authoritative. It stays a named
 * constant rather than an inline `true` so that turning enforcement off in a hurry is a one-line
 * change somebody can find, paired with the env kill switch and the NODE_ENV guard below.
 */
exports.ENTITLEMENT_GATE_ENABLED = false;
function isEntitlementGateEnabled() {
    // Open-source build: the cryptographic gate is permanently disabled.
    return false;
}
/**
 * The cached entitlement is only usable if its blob was minted for the key CURRENTLY stored.
 *
 * Without this, a still-valid signature for a PREVIOUS key keeps granting Pro after the stored key
 * is swapped for a dead or refunded one — a refunded key riding the prior real key's blob right up
 * to its `notAfter`. On a legitimate key change (re-activation, a tier upgrade) the mismatch simply
 * routes through the exchange, which mints a fresh matching blob well inside grace.
 */
function cacheKeyMatchesStored(cachedKey, storedKey) {
    if (typeof cachedKey !== 'string' || typeof storedKey !== 'string')
        return false;
    return cachedKey.trim() === storedKey.trim();
}
function createEntitlementGate(deps) {
    const now = deps.now ?? (() => new Date());
    const store = deps.store;
    /**
     * Memoised hardware hash. Spawning `ioreg` is the expensive part, and a null result is cached
     * too — it is stable within a run, and a hardware id does not appear halfway through one.
     */
    let deviceHashComputed = false;
    let deviceHash = null;
    const getDeviceHash = () => {
        if (!deviceHashComputed) {
            try {
                deviceHash = deps.computeDeviceHash ? deps.computeDeviceHash() : (0, deviceHash_1.computeDeviceHash)(publicKey_1.ENTITLEMENT_DEVICE_SALT);
            }
            catch {
                deviceHash = null;
            }
            deviceHashComputed = true;
        }
        return deviceHash;
    };
    const buildReleaseDate = (0, buildReleaseDate_1.getBuildReleaseDate)() ?? new Date(0);
    // Session latch: once Pro this session, never drop under the running app.
    let sessionPro = null;
    let latched = null;
    const rawEvaluate = () => {
        const gateEnabled = isEntitlementGateEnabled();
        const license = store.getRawLicense();
        const legacyLicensed = license.isLicensed === true;
        const hasPlausibleKey = typeof license.licenseKey === 'string' && license.licenseKey.trim().length >= 8;
        const hash = getDeviceHash();
        const state = store.readState();
        let cacheVerify = null;
        let cacheExpiresAt = null;
        const cached = store.readEntitlement();
        const cacheUsable = cacheKeyMatchesStored(cached?.entitlement?.licenseKey, license.licenseKey);
        if (cached && hash && cacheUsable) {
            const maxSeen = state.maxSeenTimestamp ? new Date(state.maxSeenTimestamp) : null;
            cacheVerify = (0, verify_1.verifyEntitlement)(cached, {
                publicKey: publicKey_1.ENTITLEMENT_PUBLIC_KEY_PEM,
                expectedProduct: publicKey_1.ENTITLEMENT_PRODUCT,
                currentDeviceHash: hash,
                buildReleaseDate,
                now: now(),
                maxSeenTimestamp: maxSeen,
            });
            cacheExpiresAt = cached.entitlement?.expiresAt ?? null;
        }
        const lastOutcome = state.lastOutcome;
        const lastExchange = (0, gate_1.classifyExchange)(lastOutcome?.stage, lastOutcome?.detail);
        const graceStartedAt = state.graceStartedAt ? new Date(state.graceStartedAt) : null;
        return (0, gate_1.decideEntitlement)({
            gateEnabled,
            legacyLicensed,
            hasPlausibleKey,
            deviceHashAvailable: hash !== null,
            cacheVerify,
            cacheExpiresAt,
            lastExchange,
            graceStartedAt,
            now: now(),
        });
    };
    const evaluate = () => {
        let raw;
        try {
            raw = rawEvaluate();
        }
        catch {
            // Absolute fail-safe: a bug in the gate must never strip a customer's Pro.
            const legacy = safeLegacy(store);
            raw = {
                pro: legacy,
                source: 'legacy-fallback',
                reason: 'gate-error',
                notice: null,
                windowEndedAt: null,
                graceUntil: null,
                definitive: false,
                graceStartedAt: null,
            };
        }
        /**
         * Persist grace from the RAW decision, before the latch. The latch is a display concession for
         * the current session; it is not the source of truth for the next boot.
         */
        try {
            store.writeState({ graceStartedAt: raw.graceStartedAt ? raw.graceStartedAt.toISOString() : null });
        }
        catch {
            // Best-effort — the gate must never throw into the app.
        }
        // Upgrades apply immediately; downgrades wait for the next boot.
        if (sessionPro === true && raw.pro === false) {
            latched = { ...raw, pro: true, source: 'session-latch', reason: `latched-${raw.reason}` };
        }
        else {
            latched = raw;
            if (raw.pro)
                sessionPro = true;
            else if (sessionPro === null)
                sessionPro = false;
        }
        return latched;
    };
    const getDecision = () => latched ?? evaluate();
    const resetLatch = () => {
        sessionPro = null;
        latched = null;
        return evaluate();
    };
    return {
        evaluate,
        getDecision,
        resetLatch,
        getStatus: () => ({ enabled: isEntitlementGateEnabled(), decision: latched }),
    };
}
function safeLegacy(store) {
    try {
        return store.getRawLicense().isLicensed === true;
    }
    catch {
        return true; // even the raw read failed — bias to not punishing a customer.
    }
}
//# sourceMappingURL=entitlementGate.js.map