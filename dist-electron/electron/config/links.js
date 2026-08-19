"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EXTERNAL_LINKS = void 0;
/**
 * The outbound URLs this app is allowed to open, keyed by a short id.
 *
 * Same reasoning as `license.openCheckout`: the renderer names a destination, main owns the
 * address. A `mailto:` cannot go through the window's `setWindowOpenHandler` at all — that
 * handler only lets `https:` through — and keeping the table here means a model-authored
 * fragment rendered inside the app can never talk the shell into opening a URL of its own.
 *
 * `1showcasetool-releases` is the publish target in package.json. Deriving it from anything
 * else gets the wrong repo — the org uses both singular and plural release-repo names.
 */
exports.EXTERNAL_LINKS = {
    support: 'https://feedback.stoicsoft.com/',
    email: 'mailto:hello@stoicsoft.com',
    releases: 'https://github.com/stoicsoft/1showcasetool-releases/releases',
};
//# sourceMappingURL=links.js.map