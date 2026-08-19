"use strict";
/**
 * Hardware-derived device hash.
 *
 * The naive alternative is a `randomUUID()` written next to the licence, and it is worthless:
 * anyone can copy a friend's signed entitlement and type their device id to match. Deriving the
 * identity from HARDWARE, salting it per product, and recomputing it at verify time is what makes
 * the binding mean something.
 *
 * MAIN-PROCESS ONLY — this shells out and reads the filesystem, which is exactly why the pure
 * verifier takes `currentDeviceHash` as an injected string instead of calling in here. Every
 * failure path returns null so the caller can decide policy; the gate treats an unreadable
 * hardware id as "cannot produce a trustworthy negative" and keeps the customer's Pro.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRawHardwareId = getRawHardwareId;
exports.computeDeviceHash = computeDeviceHash;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_crypto_1 = require("node:crypto");
const EXEC_OPTS = { encoding: 'utf8', timeout: 4000 };
/** macOS: IOPlatformUUID from the IOPlatformExpertDevice registry entry. */
function readDarwinId() {
    try {
        const out = (0, node_child_process_1.execFileSync)('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], EXEC_OPTS);
        const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
        return m ? m[1] : null;
    }
    catch {
        return null;
    }
}
/** Windows: MachineGuid from HKLM\SOFTWARE\Microsoft\Cryptography. */
function readWindowsId() {
    try {
        const out = (0, node_child_process_1.execFileSync)('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], EXEC_OPTS);
        const m = out.match(/MachineGuid\s+REG_SZ\s+([^\s]+)/i);
        return m ? m[1].trim() : null;
    }
    catch {
        return null;
    }
}
/** Linux and others: /etc/machine-id, falling back to the dbus copy. */
function readLinuxId() {
    for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
            const id = (0, node_fs_1.readFileSync)(p, 'utf8').trim();
            if (id)
                return id;
        }
        catch {
            // try the next path
        }
    }
    return null;
}
/**
 * Raw, un-hashed hardware id for the given platform (defaults to the host's). Null when it cannot
 * be read — a locked-down environment, a VM, a motherboard swap.
 */
function getRawHardwareId(platform = process.platform) {
    if (platform === 'darwin')
        return readDarwinId();
    if (platform === 'win32')
        return readWindowsId();
    return readLinuxId();
}
/**
 * sha256(hardwareId + '::' + productSalt) as lowercase hex — the value the verifier compares
 * against `entitlement.deviceHash`. Salting per product keeps a hash minted for one StoicSoft app
 * from matching on another, even though they share a signing key.
 */
function computeDeviceHash(productSalt, platform = process.platform) {
    const raw = getRawHardwareId(platform);
    if (!raw)
        return null;
    return (0, node_crypto_1.createHash)('sha256').update(`${raw}::${productSalt}`).digest('hex');
}
//# sourceMappingURL=deviceHash.js.map