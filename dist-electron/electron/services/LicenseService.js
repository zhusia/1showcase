"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.licenseService = exports.LicenseService = void 0;
exports.formatLicenseError = formatLicenseError;
const CredentialVault_1 = require("./CredentialVault");
const LemonSqueezyService_1 = require("./LemonSqueezyService");
const db_1 = require("../db");
const entitlementGate_1 = require("../entitlement/entitlementGate");
const shadow_1 = require("../entitlement/shadow");
const store_1 = require("../entitlement/store");
const entitlements_1 = require("../showcasetool/entitlements");
const os_1 = __importDefault(require("os"));
const crypto_1 = require("crypto");
/**
 * Licence state, and the one place the rest of the app asks "is this install Pro?".
 *
 * Storage is split, and the split is this repo's rule rather than the sibling apps' habit. They
 * keep everything in plaintext JSON under `userData`; CLAUDE.md says secrets live in the OS
 * keychain and the database holds non-secret config only. So:
 *
 *   keychain   `license.key`          the raw Lemon Squeezy licence key
 *              `license.entitlement`  the signed entitlement blob (it embeds the key)
 *   settings   `license.record`       instance id, tier, seat counts, status, dates
 *              `license.state`        clock guard, grace window, last exchange outcome
 *
 * The keychain is async and the gate is synchronous, so both vault values are mirrored into memory
 * by `init()` at boot and written through on every change. Nothing reads the vault on the hot path;
 * `getLicenseInfo()` stays a plain function call.
 *
 * The gate's verdict is what decides Pro. The stored boolean survives only as the fail-safe the
 * gate falls back to when it cannot produce a trustworthy negative — see entitlement/gate.ts.
 */
const VAULT_KEY = 'license.key';
const VAULT_ENTITLEMENT = 'license.entitlement';
const SETTINGS_RECORD = 'license.record';
const SETTINGS_STATE = 'license.state';
const SETTINGS_DEVICE = 'license.device';
class LicenseService {
    licenseKey = null;
    entitlement = null;
    record = null;
    state = { ...store_1.EMPTY_ENTITLEMENT_STATE };
    deviceId = '';
    deviceName = os_1.default.hostname() || 'unknown-device';
    ready = false;
    gate = null;
    shadow = null;
    listeners = new Set();
    // ---------------------------------------------------------------- boot
    /**
     * Load the mirror and build the gate. Must be awaited before the first `getLicenseInfo()`, which
     * is why main calls it before `registerHandlers()` — a renderer that asked first would be told
     * "free" by an install that is paid for.
     */
    async init(appVersion) {
        if (this.ready)
            return;
        this.deviceId = this.readSetting(SETTINGS_DEVICE) ?? '';
        if (!this.deviceId) {
            this.deviceId = (0, crypto_1.randomUUID)();
            this.writeSetting(SETTINGS_DEVICE, this.deviceId);
        }
        this.record = this.readJsonSetting(SETTINGS_RECORD);
        this.state = this.readJsonSetting(SETTINGS_STATE) ?? { ...store_1.EMPTY_ENTITLEMENT_STATE };
        /**
         * A keychain that cannot be read is not a licence that does not exist. Log it and carry on with
         * an empty mirror rather than throwing — the gate's fail-safe already biases towards keeping a
         * customer's Pro, and a hard failure here would be a boot failure.
         */
        try {
            this.licenseKey = await CredentialVault_1.credentialVault.get(VAULT_KEY);
            const blob = await CredentialVault_1.credentialVault.get(VAULT_ENTITLEMENT);
            this.entitlement = blob ? JSON.parse(blob) : null;
        }
        catch (err) {
            console.warn(`[showcasetool] licence vault unreadable: ${err.message}`);
        }
        const store = this.entitlementStore();
        this.gate = (0, entitlementGate_1.createEntitlementGate)({ store });
        this.shadow = (0, shadow_1.createEntitlementShadow)({
            store,
            appVersion,
            /**
             * Re-evaluate on every pass so a purchase made while the app is open applies without a
             * restart. The session latch inside the gate is what stops the reverse.
             */
            onPass: (outcome) => {
                void outcome;
                this.gate?.evaluate();
                this.notifyChange();
            },
        });
        this.gate.evaluate();
        this.ready = true;
    }
    /** Start the boot-delayed and daily refresh. Returns a disposer. */
    startRefresh() {
        return this.shadow?.start() ?? (() => { });
    }
    /** Force a refresh now — the Settings card's "Check again" button. */
    async refreshNow() {
        if (!this.shadow)
            return null;
        const outcome = await this.shadow.run('manual');
        this.gate?.evaluate();
        this.notifyChange();
        return outcome;
    }
    // ---------------------------------------------------------------- the entitlement seam
    entitlementStore() {
        return {
            getRawLicense: () => ({
                // "Licensed" in the stored sense means a key was activated here, nothing more. The gate is
                // what turns that into a grant.
                isLicensed: Boolean(this.licenseKey && this.record),
                licenseKey: this.licenseKey,
                /**
                 * The entitlement stands in when the record is gone. Without it the exchange posts
                 * `'unactivated'`, the server refuses it, and the install rides its cached blob until
                 * `notAfter` and then falls to grace — Pro that expires quietly on a licence that is fine.
                 */
                instanceId: this.identity()?.instanceId ?? null,
            }),
            readEntitlement: () => this.entitlement,
            writeEntitlement: (signed) => {
                this.entitlement = signed;
                // Fire and forget: the in-memory mirror is already correct, and a keychain write that
                // fails must not fail the pass that produced a perfectly good entitlement.
                void CredentialVault_1.credentialVault
                    .set(VAULT_ENTITLEMENT, JSON.stringify(signed))
                    .catch((err) => console.warn(`[showcasetool] could not cache entitlement: ${err.message}`));
            },
            readState: () => this.state,
            writeState: (patch) => {
                this.state = { ...this.state, ...patch };
                this.writeSetting(SETTINGS_STATE, JSON.stringify(this.state));
            },
        };
    }
    // ---------------------------------------------------------------- the question everything asks
    /** Is this install Pro? Open-source build: always Pro. */
    isPro() {
        return true;
    }
    /** Library size and Pro state together — what the free-tier rules in entitlements.ts consume. */
    facts() {
        return { pro: this.isPro(), guideCount: this.guideCount() };
    }
    /** The watermark string for an export right now, or null when it should be clean. */
    watermark() {
        return (0, entitlements_1.watermarkFor)(this.facts());
    }
    guideCount() {
        try {
            const row = (0, db_1.getDb)().prepare(`SELECT COUNT(*) AS n FROM guides`).get();
            return row?.n ?? 0;
        }
        catch {
            // A count that cannot be read must not accidentally watermark a paying customer's export.
            return 0;
        }
    }
    // ---------------------------------------------------------------- activation
    async activate(licenseKey) {
        const trimmed = licenseKey.trim();
        if (!trimmed)
            throw new Error('Paste your licence key first.');
        // Open-source build: activation is a local no-op — no LemonSqueezy call.
        this.record = {
            lsLicenseId: null,
            instanceId: 'opensource',
            instanceName: 'Open Source',
            email: '',
            customerName: '',
            storeId: '',
            orderId: 0,
            productId: 0,
            variantId: 0,
            variantName: 'Open Source',
            activationLimit: null,
            activationUsage: 1,
            status: 'active',
            expiresAt: null,
            activatedAt: new Date().toISOString(),
            lastVerified: new Date().toISOString(),
        };
        this.licenseKey = trimmed;
        this.writeSetting(SETTINGS_RECORD, JSON.stringify(this.record));
        await CredentialVault_1.credentialVault.set(VAULT_KEY, this.licenseKey).catch(() => undefined);
        this.notifyChange();
        return this.getLicenseInfo();
    }
    /**
     * What identifies this machine to Lemon Squeezy: the licence key, and the instance the
     * activation created.
     *
     * The record is the ordinary source and the one piece here that can go missing on its own — it
     * lives in `settings` while the key and the signed entitlement live in the keychain, so a wiped
     * row or a database restored beside an intact keychain leaves an install that is Pro on a
     * verified entitlement with nothing to re-check or release it by. The entitlement is signed over
     * both halves, so it stands in.
     */
    identity() {
        const key = this.licenseKey ?? this.entitlement?.entitlement.licenseKey ?? null;
        const instanceId = this.record?.instanceId ?? this.entitlement?.entitlement.instanceId ?? null;
        if (!key || !instanceId)
            return null;
        return { key, instanceId };
    }
    /** Anything at all on this machine that claims or grants Pro. */
    hasLocalLicense() {
        return Boolean(this.licenseKey || this.record || this.entitlement);
    }
    /**
     * Build the non-secret record from a Lemon Squeezy reply.
     *
     * A validate answers with the whole licence rather than a delta, so this rebuilds rather than
     * patches — that is what lets the re-check repair a record that was lost, instead of needing one
     * to run at all. Anything the reply omits keeps whatever we already had.
     */
    recordFrom(response, instanceId) {
        const previous = this.record;
        const meta = response.meta;
        return {
            lsLicenseId: response.license_key.id,
            instanceId: response.instance?.id ?? instanceId,
            instanceName: response.instance?.name ?? previous?.instanceName ?? this.deviceName,
            email: meta?.customer_email ?? previous?.email ?? '',
            customerName: meta?.customer_name ?? previous?.customerName ?? '',
            storeId: meta?.store_id ?? previous?.storeId ?? '',
            orderId: meta?.order_id ?? previous?.orderId ?? 0,
            productId: meta?.product_id ?? previous?.productId ?? 0,
            variantId: meta?.variant_id ?? previous?.variantId ?? 0,
            variantName: meta?.variant_name ?? previous?.variantName ?? '',
            activationLimit: response.license_key.activation_limit,
            activationUsage: response.license_key.activation_usage,
            status: response.license_key.status,
            expiresAt: response.license_key.expires_at,
            activatedAt: previous?.activatedAt ?? new Date().toISOString(),
            lastVerified: new Date().toISOString(),
        };
    }
    /** Re-check. Open-source build: always valid, no LemonSqueezy call. */
    async validate() {
        const identity = this.identity();
        if (!identity)
            throw new Error('No licence is activated on this machine.');
        return this.getLicenseInfo();
    }
    /**
     * Hand this machine's seat back.
     *
     * The local clear happens whether or not the remote call succeeds, and it does not require a
     * Lemon Squeezy record. A customer who is offline, whose instance Lemon Squeezy has already
     * forgotten, or whose record was lost while the signed entitlement survived, must still be able
     * to deactivate — being stuck holding a seat you cannot release is a worse failure than a seat
     * that leaks.
     */
    async deactivate() {
        if (!this.hasLocalLicense())
            throw new Error('No licence is activated on this machine.');
        // Open-source build: deactivation is a local cleanup, no LemonSqueezy call.
        this.licenseKey = null;
        this.record = null;
        this.entitlement = null;
        this.state = { ...store_1.EMPTY_ENTITLEMENT_STATE };
        this.writeSetting(SETTINGS_RECORD, '');
        this.writeSetting(SETTINGS_STATE, JSON.stringify(this.state));
        await CredentialVault_1.credentialVault.delete(VAULT_KEY).catch(() => undefined);
        await CredentialVault_1.credentialVault.delete(VAULT_ENTITLEMENT).catch(() => undefined);
        this.notifyChange();
        return this.getLicenseInfo();
    }
    // ---------------------------------------------------------------- reporting
    getLicenseInfo() {
        // Open-source build: always fully licensed. No key, no server, no gate.
        const record = this.record;
        return {
            isLicensed: true,
            licenseKey: record?.licenseKey
                ? `••••-••••-••••-${record.licenseKey.slice(-4)}`
                : null,
            email: record?.email ?? null,
            customerName: record?.customerName ?? null,
            deviceLimit: null,
            activatedDevices: record?.activationUsage ?? 0,
            status: 'active',
            variantName: 'Open Source',
            expiresAt: null,
            canUpdate: true,
            proSource: 'open-source',
            entitlementNotice: null,
            graceUntil: null,
            deviceName: this.deviceName,
            guideCount: this.guideCount(),
            cleanGuidesRemaining: null,
            watermark: false,
        };
    }
    /** Gate and refresh diagnostics, for the Settings card's details line. */
    getDiagnostics() {
        const status = this.gate?.getStatus();
        return {
            gateEnabled: status?.enabled ?? false,
            reason: status?.decision?.reason ?? null,
            lastOutcome: this.shadow?.getStatus().lastOutcome ?? null,
        };
    }
    // ---------------------------------------------------------------- change notification
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    notifyChange() {
        for (const listener of this.listeners) {
            try {
                listener();
            }
            catch (err) {
                console.warn(`[showcasetool] licence listener threw: ${err.message}`);
            }
        }
    }
    // ---------------------------------------------------------------- settings helpers
    readSetting(key) {
        const row = (0, db_1.getDb)().prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
        return row?.value || null;
    }
    readJsonSetting(key) {
        const raw = this.readSetting(key);
        if (!raw)
            return null;
        try {
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    writeSetting(key, value) {
        (0, db_1.getDb)()
            .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
            .run(key, value);
    }
}
exports.LicenseService = LicenseService;
/**
 * Lemon Squeezy's raw errors are written for a developer reading a response body. This is the one
 * place they become something a buyer can act on.
 */
function formatLicenseError(message) {
    const lower = message.toLowerCase();
    if (lower.includes('license_key not found') || lower.includes('license key not found')) {
        return 'That licence key was not recognised. Check for a typo, or paste it again from your receipt email.';
    }
    if (lower.includes('activation limit')) {
        return 'This licence is already on all of its devices. Deactivate it on one of them first, then try again.';
    }
    if (lower.includes('instance_id not found')) {
        return 'This machine is no longer registered against that licence. Activate it again.';
    }
    if (lower.includes('expired')) {
        return 'That licence has expired. You can keep using the version you have; renewing restores new releases.';
    }
    if (lower.includes('disabled')) {
        return 'That licence has been disabled. If you think that is wrong, reply to your receipt email.';
    }
    if (lower.includes('network') || lower.includes('fetch') || lower.includes('timeout') || lower.includes('abort')) {
        return 'Could not reach the licence server. Check your connection and try again.';
    }
    return message;
}
exports.licenseService = new LicenseService();
//# sourceMappingURL=LicenseService.js.map