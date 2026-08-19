"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AGENT_SPECS = void 0;
exports.agentPath = agentPath;
exports.agentEnv = agentEnv;
exports.locateAgents = locateAgents;
exports.listAgentInventory = listAgentInventory;
exports.locateAgent = locateAgent;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
/**
 * Headless invocations mirror 1DevTool's shared headless-mode registry. Keep this list to
 * CLIs that both expose a cheap version probe and can complete one prompt without a TTY.
 * Order is preference order: routes() activates the first working binary it can find.
 */
exports.AGENT_SPECS = [
    {
        id: 'claude-code',
        label: 'Claude Code',
        bin: 'claude',
        headless: { beforePrompt: ['-p'], delivery: 'stdin' },
        versionArgs: ['--version'],
    },
    {
        id: 'codex',
        label: 'OpenAI Codex',
        bin: 'codex',
        headless: {
            beforePrompt: ['exec', '--ephemeral', '--skip-git-repo-check'],
            delivery: 'stdin',
            stdinPromptArg: '-',
        },
        versionArgs: ['--version'],
    },
    {
        id: 'gemini',
        label: 'Gemini CLI',
        bin: 'gemini',
        headless: { beforePrompt: ['-p'], delivery: 'argument' },
        versionArgs: ['--version'],
    },
    {
        id: 'kimi',
        label: 'Kimi Code',
        bin: 'kimi',
        headless: { beforePrompt: ['-p'], delivery: 'argument' },
        versionArgs: ['--version'],
    },
    {
        id: 'amp',
        label: 'Amp',
        bin: 'amp',
        headless: { beforePrompt: ['-x'], delivery: 'argument' },
        versionArgs: ['--version'],
    },
    {
        id: 'opencode',
        label: 'OpenCode',
        bin: 'opencode',
        headless: { beforePrompt: ['run'], afterPrompt: ['--auto'], delivery: 'argument' },
        versionArgs: ['--version'],
    },
    {
        id: 'qwen',
        label: 'Qwen Code',
        bin: 'qwen',
        headless: { beforePrompt: ['-p'], delivery: 'argument' },
        versionArgs: ['--version'],
    },
    {
        id: 'agy',
        label: 'Antigravity',
        bin: 'agy',
        headless: { beforePrompt: ['--print'], delivery: 'argument' },
        versionArgs: ['--version'],
    },
    {
        id: 'cline',
        label: 'Cline',
        bin: 'cline',
        headless: { beforePrompt: ['--auto-approve', 'true'], delivery: 'argument' },
        versionArgs: ['--version'],
    },
    {
        id: 'grok',
        label: 'Grok CLI',
        bin: 'grok',
        headless: { beforePrompt: ['-p'], afterPrompt: ['--always-approve'], delivery: 'argument' },
        versionArgs: ['--version'],
    },
    {
        id: 'hermes',
        label: 'Hermes Agent',
        bin: 'hermes',
        headless: { beforePrompt: ['-z'], delivery: 'argument' },
        versionArgs: ['--version'],
    },
    {
        id: 'cursor',
        label: 'Cursor CLI',
        bin: 'cursor-agent',
        headless: { beforePrompt: ['-p', '--force', '--trust'], delivery: 'argument' },
        versionArgs: ['--version'],
    },
    {
        id: 'aider',
        label: 'Aider',
        bin: 'aider',
        headless: { beforePrompt: ['--yes-always', '--message'], delivery: 'argument' },
        versionArgs: ['--version'],
    },
];
/**
 * GUI apps on macOS do not inherit the shell PATH, so a CLI the user installed via a
 * dotfile is invisible to execFile unless we look where installers actually put it.
 *
 * Finding the binary is only half the problem: many agent CLIs are `#!/usr/bin/env node`
 * trampolines (Homebrew npm globals: codex, gemini, grok). A production launch from
 * Finder/Dock has a minimal PATH, so the file is found under `/opt/homebrew/bin` but
 * `execFile(... --version)` dies with `env: node: No such file or directory` and we
 * report "Not found". Dev mode inherits the terminal PATH, so the same machine works.
 * `agentPath()` is therefore the PATH used for *both* discovery and probes/runs.
 */
function searchPaths() {
    const home = os_1.default.homedir();
    const fromEnv = (process.env.PATH ?? '').split(path_1.default.delimiter).filter(Boolean);
    const wellKnown = process.platform === 'win32'
        ? [
            path_1.default.join(process.env.LOCALAPPDATA ?? path_1.default.join(home, 'AppData', 'Local'), 'Programs'),
            path_1.default.join(process.env.APPDATA ?? path_1.default.join(home, 'AppData', 'Roaming'), 'npm'),
            path_1.default.join(process.env.LOCALAPPDATA ?? path_1.default.join(home, 'AppData', 'Local'), 'pnpm'),
            path_1.default.join(home, '.local', 'bin'),
            path_1.default.join(home, '.bun', 'bin'),
            path_1.default.join(home, '.opencode', 'bin'),
            path_1.default.join(home, '.claude', 'bin'),
            path_1.default.join(home, '.codex', 'bin'),
            path_1.default.join(home, '.grok', 'bin'),
        ]
        : [
            '/opt/homebrew/bin',
            '/opt/homebrew/sbin',
            '/usr/local/bin',
            '/usr/local/sbin',
            '/usr/bin',
            '/bin',
            path_1.default.join(home, 'bin'),
            path_1.default.join(home, '.local', 'bin'),
            path_1.default.join(home, '.bun', 'bin'),
            path_1.default.join(home, '.volta', 'bin'),
            path_1.default.join(home, '.npm-global', 'bin'),
            path_1.default.join(home, '.yarn', 'bin'),
            path_1.default.join(home, '.config', 'yarn', 'global', 'node_modules', '.bin'),
            path_1.default.join(home, '.pnpm'),
            path_1.default.join(home, '.local', 'share', 'pnpm'),
            path_1.default.join(home, 'Library', 'pnpm'),
            path_1.default.join(home, '.claude', 'local'),
            path_1.default.join(home, '.claude', 'bin'),
            path_1.default.join(home, '.codex', 'bin'),
            path_1.default.join(home, '.opencode', 'bin'),
            path_1.default.join(home, '.kimi-code', 'bin'),
            path_1.default.join(home, '.grok', 'bin'),
            path_1.default.join(home, '.antigravity', 'antigravity', 'bin'),
            path_1.default.join(home, '.cargo', 'bin'),
            path_1.default.join(home, 'go', 'bin'),
            ...versionManagerBins(home),
        ];
    return Array.from(new Set([...fromEnv, ...wellKnown].filter(Boolean)));
}
/**
 * nvm / fnm / asdf put `node` under a versioned directory that is never on a GUI app's
 * PATH. Without it, every `#!/usr/bin/env node` CLI fails its version probe even when
 * the shim itself sits in a well-known directory. Prefer the newest installed version;
 * any modern node is enough for a `--version` probe.
 */
function versionManagerBins(home) {
    const dirs = [];
    const nvmRoot = process.env.NVM_DIR || path_1.default.join(home, '.nvm');
    const nvmVersions = path_1.default.join(nvmRoot, 'versions', 'node');
    try {
        const versions = fs_1.default
            .readdirSync(nvmVersions)
            .filter((name) => !name.startsWith('.'))
            .sort()
            .reverse();
        for (const version of versions) {
            dirs.push(path_1.default.join(nvmVersions, version, 'bin'));
        }
    }
    catch {
        // nvm not installed — fine.
    }
    const fnmRoot = process.env.FNM_DIR || path_1.default.join(home, '.fnm');
    try {
        const versions = fs_1.default
            .readdirSync(path_1.default.join(fnmRoot, 'node-versions'))
            .filter((name) => !name.startsWith('.'))
            .sort()
            .reverse();
        for (const version of versions) {
            dirs.push(path_1.default.join(fnmRoot, 'node-versions', version, 'installation', 'bin'));
        }
    }
    catch {
        // fnm not installed — fine.
    }
    const asdfShims = path_1.default.join(home, '.asdf', 'shims');
    if (fs_1.default.existsSync(asdfShims))
        dirs.push(asdfShims);
    return dirs;
}
/** PATH used when locating, probing, and spawning agent CLIs. */
function agentPath() {
    return searchPaths().join(path_1.default.delimiter);
}
/**
 * Environment for agent child processes. PATH always includes the enriched agent PATH so a
 * Finder-launched app can still resolve `node` for shebang scripts. A caller-supplied
 * PATH is treated as a prefix (e.g. the binary's own directory) and merged ahead of it.
 */
function agentEnv(extra = {}) {
    const { PATH: pathPrefix, ...rest } = extra;
    const segments = [
        ...(typeof pathPrefix === 'string' ? pathPrefix.split(path_1.default.delimiter) : []),
        ...agentPath().split(path_1.default.delimiter),
    ];
    const seen = new Set();
    const merged = [];
    for (const segment of segments) {
        if (!segment || seen.has(segment))
            continue;
        seen.add(segment);
        merged.push(segment);
    }
    return { ...process.env, ...rest, PATH: merged.join(path_1.default.delimiter) };
}
function resolveBinCandidates(bin) {
    const names = process.platform === 'win32' ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin];
    const found = [];
    const seen = new Set();
    for (const dir of searchPaths()) {
        for (const name of names) {
            const candidate = path_1.default.join(dir, name);
            if (seen.has(candidate))
                continue;
            seen.add(candidate);
            try {
                if (fs_1.default.existsSync(candidate) && fs_1.default.statSync(candidate).isFile())
                    found.push(candidate);
            }
            catch {
                // An unreadable directory on the PATH is not an error worth surfacing.
            }
        }
    }
    return found;
}
function probeVersion(binPath, args) {
    return new Promise((resolve) => {
        // Enriched PATH is load-bearing: without it, `#!/usr/bin/env node` CLIs fail the
        // probe on a production launch even though resolveBin found the file. Prepend the
        // binary's own directory so an nvm/fnm install resolves its sibling `node` first.
        const env = agentEnv({ PATH: path_1.default.dirname(binPath) });
        (0, child_process_1.execFile)(binPath, args, { timeout: 5000, windowsHide: true, env }, (err, stdout) => {
            if (err) {
                resolve(null);
                return;
            }
            resolve(stdout.trim().split('\n')[0] || '');
        });
    });
}
/**
 * Feature-detect rather than trust: a binary on the PATH that will not report a version
 * is treated as absent, because generation would fail later and more confusingly.
 */
async function locateAgents() {
    const inventory = await listAgentInventory();
    return inventory
        .filter((item) => item.state === 'detected' && !!item.binPath)
        .map((item) => {
        const spec = exports.AGENT_SPECS.find((entry) => entry.id === item.id);
        return { spec, binPath: item.binPath, version: item.version ?? '' };
    });
}
/**
 * Full catalogue for the settings list and the header picker. Order matches AGENT_SPECS
 * preference — Auto walks this list first.
 */
async function listAgentInventory() {
    return Promise.all(exports.AGENT_SPECS.map(async (spec) => {
        const agent = await probeAgent(spec);
        if (!agent) {
            return { id: spec.id, label: spec.label, state: 'not-found', version: null, binPath: null };
        }
        return {
            id: spec.id,
            label: spec.label,
            state: 'detected',
            version: agent.version || null,
            binPath: agent.binPath,
        };
    }));
}
/** The first located agent remains the fast path for follower repair/explain requests. */
async function locateAgent() {
    for (const spec of exports.AGENT_SPECS) {
        const agent = await probeAgent(spec);
        if (agent)
            return agent;
    }
    return null;
}
async function probeAgent(spec) {
    // Try every candidate: a Homebrew node-trampoline can sit ahead of a native install
    // of the same name (e.g. /opt/homebrew/bin/grok vs ~/.grok/bin/grok). Feature-detect
    // each one so a broken first hit does not hide a working later path.
    for (const binPath of resolveBinCandidates(spec.bin)) {
        const version = await probeVersion(binPath, spec.versionArgs);
        if (version !== null)
            return { spec, binPath, version };
    }
    return null;
}
//# sourceMappingURL=cli-locator.js.map