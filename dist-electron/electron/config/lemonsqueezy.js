"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRICING = exports.LEMONSQUEEZY_CONFIG = void 0;
/**
 * Lemon Squeezy identifiers for 1ShowcaseTool Pro.
 *
 * Open-source build: no LemonSqueezy store/product/checkout config is shipped.
 * The app is fully unlocked and does not call the LemonSqueezy API.
 */
exports.LEMONSQUEEZY_CONFIG = {
    storeId: null,
    productId: 0,
    variants: {
        singleDevice: 0,
        threeDevices: 0,
        fiveDevices: 0,
    },
    checkoutUrls: {
        singleDevice: '',
        threeDevices: '',
        fiveDevices: '',
    },
    api: {
        baseUrl: '',
    },
};
/** Display pricing. Lemon Squeezy is what actually charges; this only mirrors it for the UI. */
exports.PRICING = [];
//# sourceMappingURL=lemonsqueezy.js.map