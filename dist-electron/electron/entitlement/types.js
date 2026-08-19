"use strict";
/**
 * The signed-entitlement wire types.
 *
 * The store (stoicsoft-store, `POST /api/entitlement`) mints a `SignedEntitlement`: the
 * `entitlement` payload plus an Ed25519 `signature` over the CANONICAL bytes of that payload
 * (see ./canonicalize.ts). This app caches payload + signature and verifies locally with the
 * embedded public key. The private key never ships and never leaves the production VPS.
 *
 * ⚠️ CROSS-REPO MIRROR. `types.ts`, `canonicalize.ts` and `verify.ts` must stay behaviourally
 * identical to `lib/entitlement/` in stoicsoft-store. A one-character divergence in the
 * canonicaliser makes every signature fail on a customer's machine, and it fails as a *silent*
 * "bad-signature" rather than as a build error.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map