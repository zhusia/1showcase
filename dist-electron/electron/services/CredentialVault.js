"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.credentialVault = exports.CredentialVault = void 0;
const keytar_1 = __importDefault(require("keytar"));
const SERVICE = 'oneshowcasetool';
/**
 * One consolidated keychain item rather than one per credential. Per-item storage
 * causes a keychain prompt per read, which on a flow that writes four connector fields
 * in a row is four prompts.
 */
const VAULT_ACCOUNT = '__vault__';
/**
 * Secrets live in the OS keychain and nowhere else. There is deliberately no plaintext
 * fallback: if keytar is unavailable the write fails loudly rather than silently
 * landing a harvested credential in SQLite or a log.
 */
class CredentialVault {
    cache = null;
    async read() {
        if (this.cache)
            return this.cache;
        const raw = await keytar_1.default.getPassword(SERVICE, VAULT_ACCOUNT);
        if (!raw) {
            this.cache = {};
            return this.cache;
        }
        try {
            const parsed = JSON.parse(raw);
            this.cache = parsed && typeof parsed === 'object' ? parsed : {};
        }
        catch {
            // A corrupt vault must not be silently reset — that would destroy a user's keys.
            throw new Error('Credential vault is unreadable. Refusing to overwrite it.');
        }
        return this.cache;
    }
    async write(map) {
        await keytar_1.default.setPassword(SERVICE, VAULT_ACCOUNT, JSON.stringify(map));
        this.cache = map;
    }
    async get(key) {
        const map = await this.read();
        return map[key] ?? null;
    }
    async set(key, value) {
        if (!key)
            throw new Error('vault key required');
        const map = { ...(await this.read()) };
        map[key] = value;
        await this.write(map);
    }
    async setMany(entries) {
        const map = { ...(await this.read()), ...entries };
        await this.write(map);
    }
    async delete(key) {
        const map = { ...(await this.read()) };
        if (!(key in map))
            return;
        delete map[key];
        await this.write(map);
    }
    /** Key names only. Never returns values — callers that need one ask for it by name. */
    async listKeys() {
        return Object.keys(await this.read()).sort();
    }
    async has(key) {
        return (await this.get(key)) !== null;
    }
    invalidateCache() {
        this.cache = null;
    }
}
exports.CredentialVault = CredentialVault;
exports.credentialVault = new CredentialVault();
//# sourceMappingURL=CredentialVault.js.map