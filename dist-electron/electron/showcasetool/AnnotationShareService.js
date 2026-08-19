"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.annotationShareService = exports.AnnotationShareService = void 0;
const http_1 = __importDefault(require("http"));
const os_1 = __importDefault(require("os"));
const crypto_1 = require("crypto");
/**
 * A private, dependency-free secure-link server for teams on the same network. Images stay in
 * memory, disappear on expiry (or first successful open), and never cross a third-party cloud.
 * The link naturally stops working when the app closes, which is the safest failure mode.
 */
class AnnotationShareService {
    shares = new Map();
    server = null;
    port = 0;
    async create(png, options) {
        await this.ensureServer();
        const id = (0, crypto_1.randomUUID)().replace(/-/g, '').slice(0, 20);
        const minutes = Math.min(7 * 24 * 60, Math.max(1, Math.round(options.expiresMinutes || 60)));
        const expiresAt = Date.now() + minutes * 60_000;
        this.shares.set(id, {
            png,
            password: (options.password ?? '').slice(0, 128),
            expiresAt,
            selfDestruct: options.selfDestruct === true,
        });
        this.prune();
        return { url: `http://${lanAddress()}:${this.port}/s/${id}`, expiresAt: new Date(expiresAt).toISOString() };
    }
    async ensureServer() {
        if (this.server)
            return;
        this.server = http_1.default.createServer((request, response) => this.respond(request, response));
        await new Promise((resolve, reject) => {
            this.server?.once('error', reject);
            this.server?.listen(0, '0.0.0.0', () => resolve());
        });
        const address = this.server.address();
        this.port = typeof address === 'object' && address ? address.port : 0;
    }
    respond(request, response) {
        this.prune();
        const requestUrl = new URL(request.url ?? '/', 'http://localhost');
        const match = /^\/s\/([a-f0-9]{20})$/.exec(requestUrl.pathname);
        const share = match ? this.shares.get(match[1]) : undefined;
        if (!share) {
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            response.end('This image link has expired or was already opened.');
            return;
        }
        if (share.password && requestUrl.searchParams.get('password') !== share.password) {
            const wrong = requestUrl.searchParams.has('password');
            response.writeHead(401, securityHeaders('text/html; charset=utf-8'));
            response.end(passwordPage(wrong));
            return;
        }
        if (share.password) {
            response.writeHead(200, securityHeaders('text/html; charset=utf-8'));
            response.end(imagePage(share.png));
        }
        else {
            response.writeHead(200, securityHeaders('image/png'));
            response.end(share.png);
        }
        if (share.selfDestruct && match)
            this.shares.delete(match[1]);
    }
    prune() {
        const now = Date.now();
        for (const [id, share] of this.shares)
            if (share.expiresAt <= now)
                this.shares.delete(id);
    }
}
exports.AnnotationShareService = AnnotationShareService;
function securityHeaders(contentType) {
    return {
        'content-type': contentType,
        'cache-control': 'no-store, no-cache, must-revalidate',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'self'",
    };
}
function passwordPage(wrong) {
    return `<!doctype html><meta name="viewport" content="width=device-width"><title>Protected screenshot</title>
    <style>${pageCss()}input,button{font:inherit;padding:10px 12px;border-radius:7px;border:1px solid #34404d}input{background:#0b0e14;color:#eef4f8}button{background:#22b8d6;color:#071017;font-weight:700;cursor:pointer}.error{color:#ff9e96}</style>
    <main><h1>Protected screenshot</h1><p>${wrong ? '<span class="error">That password did not match.</span>' : 'Enter the password shared by its creator.'}</p><form><input name="password" type="password" autofocus required><button>Open</button></form></main>`;
}
function imagePage(png) {
    return `<!doctype html><meta name="viewport" content="width=device-width"><title>Shared screenshot</title>
    <style>${pageCss()}main{max-width:min(94vw,1400px)}img{display:block;max-width:100%;height:auto;border-radius:10px;box-shadow:0 20px 70px #0008}</style>
    <main><img src="data:image/png;base64,${png.toString('base64')}" alt="Shared screenshot"></main>`;
}
function pageCss() {
    return 'html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e14;color:#e6edf3;font:15px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}main{padding:28px}h1{font-size:20px}p{color:#93a1ae}form{display:flex;gap:8px;flex-wrap:wrap}';
}
function lanAddress() {
    for (const entries of Object.values(os_1.default.networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.family === 'IPv4' && !entry.internal)
                return entry.address;
        }
    }
    return '127.0.0.1';
}
exports.annotationShareService = new AnnotationShareService();
//# sourceMappingURL=AnnotationShareService.js.map