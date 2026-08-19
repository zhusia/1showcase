"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeHandover = sanitizeHandover;
exports.stampGuide = stampGuide;
exports.isStampablePlaceholder = isStampablePlaceholder;
const customize_1 = require("./customize");
/**
 * Export-time stamping. The Maker fills a small set of non-secret tokens when exporting,
 * producing a per-recipient file — the same path branding already uses. Secret-shaped
 * placeholders (password, token, secret…) are not stampable.
 */
const DATA_URI = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[a-z0-9+/=]+$/i;
const SECRETISH = /password|secret|token|passwd|apikey|private|credential/i;
function sanitizeHandover(stamp) {
    if (!stamp)
        return {};
    const recipient = clean(stamp.recipient, 80);
    const company = clean(stamp.company, 80);
    const logo = stamp.logo && DATA_URI.test(stamp.logo) && stamp.logo.length <= customize_1.MAX_LOGO_BYTES ? stamp.logo : undefined;
    return { recipient, company, logo };
}
function clean(value, max) {
    if (!value)
        return undefined;
    const trimmed = value.trim().slice(0, max);
    if (!trimmed || SECRETISH.test(trimmed))
        return undefined;
    return trimmed;
}
/** Apply a stamp to a copy of the guide. Branding is overwritten only for this export. */
function stampGuide(guide, stamp) {
    const cleanStamp = sanitizeHandover(stamp);
    if (!cleanStamp.recipient && !cleanStamp.company && !cleanStamp.logo)
        return guide;
    const branding = {
        enabled: true,
        accent: guide.branding?.accent ?? '#22b8d6',
        organisation: cleanStamp.company || guide.branding?.organisation || '',
        font: guide.branding?.font ?? 'system',
        showAttribution: guide.branding?.showAttribution ?? true,
        logo: cleanStamp.logo || guide.branding?.logo,
    };
    const title = cleanStamp.recipient ? `${guide.title} — for ${cleanStamp.recipient}` : guide.title;
    const intent = [guide.intent, cleanStamp.recipient ? `Prepared for ${cleanStamp.recipient}.` : '', cleanStamp.company ? `${cleanStamp.company}.` : '']
        .filter(Boolean)
        .join(' ');
    return { ...guide, title, intent, branding };
}
function isStampablePlaceholder(name) {
    return !SECRETISH.test(name);
}
//# sourceMappingURL=personalize.js.map