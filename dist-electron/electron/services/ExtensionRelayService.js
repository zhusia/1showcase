"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extensionRelay = exports.ExtensionRelayService = exports.TOKEN_HEADER = exports.RELAY_PORT_RANGE = exports.RELAY_HOST = void 0;
const http_1 = __importDefault(require("http"));
const crypto_1 = require("crypto");
const electron_1 = require("electron");
const db_1 = require("../db");
exports.RELAY_HOST = '127.0.0.1';
/** The extension probes this range in order; the app binds the first free port. */
exports.RELAY_PORT_RANGE = [47821, 47822, 47823, 47824, 47825];
exports.TOKEN_HEADER = 'x-oneshowcasetool-token';
const RELAY_TOKEN_KEY = 'relay.token';
/** Screenshots arrive as data URIs, so bodies are large — but never unbounded. */
const MAX_BODY_BYTES = 24 * 1024 * 1024;
const PAIR_TIMEOUT_MS = 60_000;
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            }
            catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}
/**
 * The single transport between the extension and the app: token-authed, 127.0.0.1 only,
 * CORS restricted to chrome-extension:// origins. Everything the extension needs —
 * recording, replay, harvest, AI repair — goes through here. There is no second
 * protocol and no path to the network.
 */
class ExtensionRelayService {
    server = null;
    port = null;
    routes = new Map();
    pending = null;
    pairedOrigins = new Set();
    register(route) {
        this.routes.set(`${route.method} ${route.path}`, route);
    }
    activePort() {
        return this.port;
    }
    token() {
        const row = (0, db_1.getDb)().prepare(`SELECT value FROM settings WHERE key = ?`).get(RELAY_TOKEN_KEY);
        if (row && row.value.length >= 32)
            return row.value;
        const token = (0, crypto_1.randomBytes)(24).toString('hex');
        (0, db_1.getDb)()
            .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
            .run(RELAY_TOKEN_KEY, token);
        return token;
    }
    /** Invalidate the token, forcing every extension to pair again. */
    rotateToken() {
        (0, db_1.getDb)().prepare(`DELETE FROM settings WHERE key = ?`).run(RELAY_TOKEN_KEY);
        this.pairedOrigins.clear();
        return this.token();
    }
    async start() {
        if (this.port)
            return this.port;
        this.registerBuiltins();
        for (const candidate of exports.RELAY_PORT_RANGE) {
            const bound = await this.tryListen(candidate);
            if (bound) {
                this.port = candidate;
                return candidate;
            }
        }
        throw new Error(`could not bind the relay on any of ports ${exports.RELAY_PORT_RANGE.join(', ')}`);
    }
    tryListen(port) {
        return new Promise((resolve) => {
            const server = http_1.default.createServer((req, res) => void this.handle(req, res));
            const onError = () => {
                server.removeAllListeners();
                server.close();
                resolve(false);
            };
            server.once('error', onError);
            server.listen(port, exports.RELAY_HOST, () => {
                server.removeListener('error', onError);
                // A permanent listener replaces the bind-time one. Without it, any later socket error
                // is an unhandled 'error' event on an EventEmitter — a throw in the main process.
                server.on('error', (err) => console.error(`[relay] server error: ${err.message}`));
                this.server = server;
                resolve(true);
            });
        });
    }
    stop() {
        // close() alone waits for keep-alive sockets the extension holds open; quitting must not.
        this.server?.closeAllConnections();
        this.server?.close();
        this.server = null;
        this.port = null;
    }
    sendJson(res, status, data, origin) {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (origin?.startsWith('chrome-extension://')) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
            res.setHeader('Access-Control-Allow-Headers', `content-type, ${exports.TOKEN_HEADER}`);
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        }
        res.end(JSON.stringify(data));
    }
    isAuthorized(req) {
        const provided = req.headers[exports.TOKEN_HEADER];
        return typeof provided === 'string' && provided.length > 0 && provided === this.token();
    }
    /**
     * Reject traffic that is provably coming from a web page.
     *
     * A browser always attaches an Origin header to a cross-origin request from a page, so an
     * Origin of `https://…` is positive evidence of drive-by localhost traffic and is refused.
     * An **absent** Origin has to be allowed: Chrome omits the header entirely on fetches made
     * from an extension service worker to a host in `host_permissions`, which is our own
     * recorder and overlay traffic. Requiring the header rejected the only legitimate caller.
     *
     * The token is the actual boundary — it is minted only after a human approves the pairing
     * and lives in the extension's storage, which no web page can read. This check is
     * defence-in-depth on top of that, not a substitute for it.
     */
    isForbiddenOrigin(origin) {
        if (!origin || origin === 'null')
            return false;
        return !origin.startsWith('chrome-extension://');
    }
    async handle(req, res) {
        const origin = req.headers.origin;
        if (req.method === 'OPTIONS') {
            this.sendJson(res, 204, {}, origin);
            return;
        }
        let url;
        try {
            url = new URL(req.url ?? '/', `http://${exports.RELAY_HOST}:${this.port ?? exports.RELAY_PORT_RANGE[0]}`);
        }
        catch {
            this.sendJson(res, 400, { error: 'bad request' }, origin);
            return;
        }
        const route = this.routes.get(`${req.method} ${url.pathname}`);
        if (!route) {
            this.sendJson(res, 404, { error: 'not found' }, origin);
            return;
        }
        // Applies to every route, including the open ones: a web page should not be able to
        // discover the app or spam the pairing prompt, and `open` only ever meant "no token".
        if (this.isForbiddenOrigin(origin)) {
            this.sendJson(res, 403, { error: 'forbidden origin' }, origin);
            return;
        }
        if (!route.open && !this.isAuthorized(req)) {
            this.sendJson(res, 401, { error: 'unauthorized' }, origin);
            return;
        }
        try {
            const body = req.method === 'POST' ? await readBody(req) : {};
            const result = await route.handle(body, url);
            this.sendJson(res, 200, result ?? { ok: true }, origin);
        }
        catch (err) {
            this.sendJson(res, 400, { error: err.message }, origin);
        }
    }
    registerBuiltins() {
        this.register({
            method: 'GET',
            path: '/health',
            open: true,
            /**
             * `pid` lets a caller confirm which instance answered. Loopback-only and behind the
             * origin check, and it makes an otherwise silent failure obvious: a stale app holding
             * the first port in the range means a fresh one binds the next, and a probe that just
             * scans for "something healthy" will happily talk to the wrong build.
             */
            handle: () => ({ ok: true, app: 'oneshowcasetool', port: this.port, pid: process.pid }),
        });
        this.register({
            method: 'POST',
            path: '/pair',
            open: true,
            handle: async (_body, url) => {
                const origin = url.searchParams.get('origin') ?? '';
                const approved = await this.requestPairApproval(origin);
                if (!approved)
                    throw new Error('pairing declined');
                return { token: this.token() };
            },
        });
    }
    /**
     * Pairing is a human decision, made in the app window. The extension cannot obtain a
     * token by asking politely — someone has to click Allow, once, per extension install.
     */
    requestPairApproval(origin) {
        if (this.pairedOrigins.has(origin))
            return Promise.resolve(true);
        if (this.pending)
            return Promise.resolve(false);
        const windows = electron_1.BrowserWindow.getAllWindows();
        if (!windows.length)
            return Promise.resolve(false);
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pending = null;
                resolve(false);
            }, PAIR_TIMEOUT_MS);
            this.pending = {
                origin,
                timer,
                resolve: (approved) => {
                    clearTimeout(timer);
                    this.pending = null;
                    if (approved)
                        this.pairedOrigins.add(origin);
                    resolve(approved);
                },
            };
            windows[0].webContents.send('showcasetool:pair-request', { origin });
            windows[0].show();
        });
    }
    /** Called from IPC when the user answers the pairing prompt. */
    resolvePairRequest(approved) {
        if (!this.pending)
            return false;
        this.pending.resolve(approved);
        return true;
    }
    pendingPairOrigin() {
        return this.pending?.origin ?? null;
    }
}
exports.ExtensionRelayService = ExtensionRelayService;
exports.extensionRelay = new ExtensionRelayService();
//# sourceMappingURL=ExtensionRelayService.js.map