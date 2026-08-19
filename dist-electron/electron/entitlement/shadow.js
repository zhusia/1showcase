"use strict";
/**
 * The entitlement refresh runner.
 *
 * On boot (+15s) and every 24h it exchanges the stored licence for a signed entitlement at the
 * store, verifies it with the embedded public key exactly as the gate will, caches it, and records
 * the outcome. The cached blob is what makes the app work offline: once minted it verifies locally
 * until its `notAfter`, roughly thirty days out.
 *
 * The exchange carries no credential of its own. Trust runs the other way — the app trusts the
 * SIGNATURE on the response, never the transport, so a hostile proxy can withhold an entitlement
 * but cannot forge one.
 *
 * Kill switch: ONESHOWCASETOOL_DISABLE_ENTITLEMENT_SHADOW=1.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SHADOW_INTERVAL_MS = void 0;
exports.isShadowDisabled = isShadowDisabled;
exports.createEntitlementShadow = createEntitlementShadow;
const verify_1 = require("./verify");
const clockGuard_1 = require("./clockGuard");
const deviceHash_1 = require("./deviceHash");
const publicKey_1 = require("./publicKey");
const buildReleaseDate_1 = require("./buildReleaseDate");
const shadowCore_1 = require("./shadowCore");
const EXCHANGE_TIMEOUT_MS = 15_000;
exports.SHADOW_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * Boot delay. The first thing a launch has to do is paint a window and start the relay; a licence
 * refresh is never urgent enough to compete with either.
 */
const BOOT_DELAY_MS = 15_000;
function isShadowDisabled() {
    // Open-source build: the entitlement exchange is permanently disabled.
    return true;
}
function createEntitlementShadow(deps) {
    const endpoint = deps.endpoint ?? publicKey_1.ENTITLEMENT_ENDPOINT;
    const now = deps.now ?? (() => new Date());
    const store = deps.store;
    let lastOutcome = null;
    const finish = (partial, legacyPro, maskedKey) => {
        const shadowPro = (0, shadowCore_1.computeShadowPro)(partial);
        const outcome = { ...partial, shadowPro, legacyPro, agrees: (0, shadowCore_1.computeAgrees)(shadowPro, legacyPro) };
        lastOutcome = outcome;
        try {
            store.writeState({ lastOutcome: outcome });
        }
        catch {
            // Best-effort.
        }
        console.log('[showcasetool] entitlement', (0, shadowCore_1.buildLogLine)(outcome, maskedKey));
        if (deps.onPass) {
            try {
                deps.onPass(outcome);
            }
            catch {
                // Best-effort — a gate or UI callback must never break a pass.
            }
        }
        return outcome;
    };
    const run = async (trigger) => {
        const at = now().toISOString();
        const license = store.getRawLicense();
        const legacyPro = license.isLicensed === true;
        const maskedKey = (0, shadowCore_1.maskLicenseKey)(license.licenseKey);
        if (isShadowDisabled()) {
            return finish({ at, trigger, stage: 'disabled' }, legacyPro, maskedKey);
        }
        if (!(0, shadowCore_1.isPlausibleLicenseKey)(license.licenseKey)) {
            return finish({ at, trigger, stage: 'no-license' }, legacyPro, maskedKey);
        }
        const deviceHash = (0, deviceHash_1.computeDeviceHash)(publicKey_1.ENTITLEMENT_DEVICE_SALT);
        if (!deviceHash) {
            return finish({ at, trigger, stage: 'device-unavailable' }, legacyPro, maskedKey);
        }
        // ---------------------------------------------------------------- exchange
        const started = Date.now();
        let response;
        let body;
        try {
            response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    licenseKey: license.licenseKey.trim(),
                    instanceId: license.instanceId ?? 'unactivated',
                    deviceHash,
                    product: publicKey_1.ENTITLEMENT_PRODUCT,
                    version: deps.appVersion ?? 'unknown',
                }),
                signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
            });
            body = await response.json().catch(() => null);
        }
        catch (error) {
            return finish({
                at,
                trigger,
                stage: 'exchange-transient',
                detail: error instanceof Error ? error.name : 'network-error',
                latencyMs: Date.now() - started,
            }, legacyPro, maskedKey);
        }
        const latencyMs = Date.now() - started;
        if (!response.ok) {
            const errCode = body && typeof body === 'object' && 'error' in body ? String(body.error) : '';
            return finish({
                at,
                trigger,
                stage: (0, shadowCore_1.isDefinitiveExchangeStatus)(response.status) ? 'exchange-definitive' : 'exchange-transient',
                detail: `${response.status} ${errCode}`.trim(),
                latencyMs,
            }, legacyPro, maskedKey);
        }
        // ---------------------------------------------------------------- verify
        const state = store.readState();
        const priorMaxSeen = state.maxSeenTimestamp ? new Date(state.maxSeenTimestamp) : null;
        const nowDate = now();
        const verify = (0, verify_1.verifyEntitlement)(body, {
            publicKey: publicKey_1.ENTITLEMENT_PUBLIC_KEY_PEM,
            expectedProduct: publicKey_1.ENTITLEMENT_PRODUCT,
            currentDeviceHash: deviceHash,
            // No stamp (a dev or source build) → epoch, so an unstamped build never denies Pro.
            buildReleaseDate: (0, buildReleaseDate_1.getBuildReleaseDate)() ?? new Date(0),
            now: nowDate,
            maxSeenTimestamp: priorMaxSeen,
        });
        const signed = body;
        const notAfter = signed?.entitlement?.notAfter;
        // Clock guard bookkeeping: fold in `now` and the server's own issuedAt.
        const nextMaxSeen = (0, clockGuard_1.advanceMaxSeen)(priorMaxSeen, nowDate, signed?.entitlement?.issuedAt);
        try {
            store.writeState({ maxSeenTimestamp: nextMaxSeen ? nextMaxSeen.toISOString() : null });
        }
        catch {
            // Best-effort.
        }
        // Cache only a blob that verified. A rejection must never clobber a good cache.
        if (verify.ok) {
            try {
                store.writeEntitlement(signed);
            }
            catch {
                // Best-effort.
            }
        }
        return finish({ at, trigger, stage: 'verified', verify, latencyMs, notAfter }, legacyPro, maskedKey);
    };
    const getStatus = () => ({
        lastOutcome: lastOutcome ?? store.readState().lastOutcome ?? null,
        enabled: !isShadowDisabled(),
    });
    const start = () => {
        if (isShadowDisabled())
            return () => { };
        const bootTimer = setTimeout(() => {
            void run('boot').catch(() => { });
        }, BOOT_DELAY_MS);
        const interval = setInterval(() => {
            void run('interval').catch(() => { });
        }, exports.SHADOW_INTERVAL_MS);
        return () => {
            clearTimeout(bootTimer);
            clearInterval(interval);
        };
    };
    return { run, getStatus, start };
}
//# sourceMappingURL=shadow.js.map