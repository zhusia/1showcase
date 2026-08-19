"use strict";
/**
 * The persistence seam between the entitlement layer and this app.
 *
 * The sibling apps keep the licence, the cached blob and the gate state in four plaintext JSON
 * files under `userData`. This app cannot: CLAUDE.md's security rule is that secrets live in the
 * OS keychain and the database holds non-secret config only, and both the licence key and the
 * cached entitlement (which embeds that key) are secrets. So the split here is
 *
 *   keychain (CredentialVault)  licence key, the signed entitlement blob
 *   settings table              the non-secret record, the clock guard, the grace bookkeeping
 *
 * The vault is async and the gate is synchronous, so LicenseService mirrors both into memory at
 * boot and writes through on change; everything below reads that mirror. Defining the seam as an
 * interface rather than reaching for `fs` is also what lets the gate be exercised without a
 * keychain, which is the only way `verify:core` can see it at all.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMPTY_ENTITLEMENT_STATE = void 0;
exports.EMPTY_ENTITLEMENT_STATE = {
    maxSeenTimestamp: null,
    graceStartedAt: null,
    lastOutcome: null,
};
//# sourceMappingURL=store.js.map