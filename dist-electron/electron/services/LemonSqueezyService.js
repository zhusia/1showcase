"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lemonSqueezyService = exports.LemonSqueezyService = void 0;
class LemonSqueezyService {
    async activateLicense(licenseKey, instanceName) {
        throw new Error('License activation is not required in the open-source build.');
    }
    async validateLicense(licenseKey, instanceId) {
        throw new Error('License validation is not required in the open-source build.');
    }
    async deactivateLicense(licenseKey, instanceId) {
        throw new Error('License deactivation is not required in the open-source build.');
    }
    validateLicenseMeta(meta) {
        // No-op: cross-product validation is irrelevant in the open-source build.
    }
}
exports.LemonSqueezyService = LemonSqueezyService;
exports.lemonSqueezyService = new LemonSqueezyService();
