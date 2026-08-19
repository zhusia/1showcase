"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseTarget = parseTarget;
exports.getDestination = getDestination;
exports.setDestination = setDestination;
exports.deliver = deliver;
const http_1 = __importDefault(require("http"));
const db_1 = require("../db");
const CredentialVault_1 = require("../services/CredentialVault");
const TARGET_RE = /^connector:([a-z0-9_-]+)\/([a-z0-9_-]+)$/i;
function parseTarget(target) {
    const match = TARGET_RE.exec(target.trim());
    if (!match)
        throw new Error(`invalid harvest target "${target}" — expected connector:<name>/<field>`);
    return { connector: match[1].toLowerCase(), field: match[2].toLowerCase() };
}
const SETTINGS_KEY = 'harvest.destination';
function getDestination() {
    const row = (0, db_1.getDb)().prepare(`SELECT value FROM settings WHERE key = ?`).get(SETTINGS_KEY);
    if (!row)
        return { kind: 'vault', label: '1ShowcaseTool vault' };
    try {
        return JSON.parse(row.value);
    }
    catch {
        return { kind: 'vault', label: '1ShowcaseTool vault' };
    }
}
function setDestination(config) {
    if (config.kind === 'forward' && (!config.port || !config.token)) {
        throw new Error('forward destination requires a port and a token');
    }
    (0, db_1.getDb)()
        .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(SETTINGS_KEY, JSON.stringify(config));
}
/**
 * Write one harvested value to the configured destination.
 *
 * The value arrives here, is written, and is not retained: no caller logs it, no store
 * keeps it, and it is never echoed back in the result. The return value is deliberately
 * just a description of where it landed.
 */
async function deliver(target, value) {
    const { connector, field } = parseTarget(target);
    const config = getDestination();
    if (config.kind === 'vault') {
        await CredentialVault_1.credentialVault.set(`connector.${connector}.${field}`, value);
        return { destination: `${config.label} → ${connector}/${field}` };
    }
    await forwardToPeer(config, connector, field, value);
    return { destination: `${config.label} → ${connector}/${field}` };
}
/** POST to a peer app's loopback relay. 127.0.0.1 is hardcoded, not configurable. */
function forwardToPeer(config, connector, field, value) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ connector, field, value });
        const req = http_1.default.request({
            host: '127.0.0.1',
            port: config.port,
            path: '/connector-credential',
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
                authorization: `Bearer ${config.token}`,
            },
            timeout: 5000,
        }, (res) => {
            res.resume();
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300)
                resolve();
            else
                reject(new Error(`destination app returned ${res.statusCode}`));
        });
        req.on('timeout', () => req.destroy(new Error('destination app did not respond')));
        req.on('error', (err) => reject(new Error(`destination app unreachable: ${err.message}`)));
        req.end(body);
    });
}
//# sourceMappingURL=HarvestDestinations.js.map