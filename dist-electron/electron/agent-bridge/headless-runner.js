"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runHeadless = runHeadless;
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const cli_locator_1 = require("./cli-locator");
const RUN_TIMEOUT_MS = 5 * 60_000;
/**
 * One-shot headless run: prompt delivery follows the CLI's own non-interactive contract,
 * and the completion comes back on stdout. No tool injection and no session — generation
 * is a single request/response, so the simplest transport is the right one.
 */
function runHeadless(agent, prompt, signal) {
    return new Promise((resolve) => {
        const { beforePrompt, afterPrompt = [], delivery, stdinPromptArg } = agent.spec.headless;
        const promptArgs = delivery === 'argument' ? [prompt] : stdinPromptArg ? [stdinPromptArg] : [];
        const child = (0, child_process_1.spawn)(agent.binPath, [...beforePrompt, ...promptArgs, ...afterPrompt], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            // Enriched PATH so `#!/usr/bin/env node` CLIs resolve under a Finder-launched app.
            // Binary dir first so nvm/fnm installs find their sibling `node`. Starts from
            // process.env so the CLI still finds its own credentials; BYOK keys for this
            // app live in the vault, not process.env.
            env: (0, cli_locator_1.agentEnv)({
                NO_COLOR: '1',
                PATH: path_1.default.dirname(agent.binPath),
            }),
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(result);
        };
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish({ ok: false, error: `agent CLI timed out after ${RUN_TIMEOUT_MS / 1000}s` });
        }, RUN_TIMEOUT_MS);
        // Named and removed in finish(): an AbortController that outlives this run would otherwise
        // hold the closure — and the child handle — for as long as the controller exists.
        const onAbort = () => {
            child.kill('SIGTERM');
            finish({ ok: false, error: 'cancelled' });
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', (err) => finish({ ok: false, error: `could not run ${agent.spec.label}: ${err.message}` }));
        child.on('close', (code) => {
            if (code === 0)
                finish({ ok: true, text: stdout });
            else
                finish({ ok: false, error: stderr.trim() || `${agent.spec.label} exited with code ${code}` });
        });
        /**
         * A CLI that rejects its arguments exits before it ever reads the prompt, and the write below
         * then fails with EPIPE. An unhandled `'error'` on a stream is rethrown by Node, which in the
         * main process ends the app rather than the generation — so the failure is absorbed here and
         * reported by the `close` handler, which has the CLI's own stderr to explain it.
         */
        child.stdin.on('error', () => undefined);
        if (delivery === 'stdin')
            child.stdin.end(prompt, 'utf8');
        else
            child.stdin.end();
    });
}
//# sourceMappingURL=headless-runner.js.map