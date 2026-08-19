"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ttsService = exports.WAV_SAMPLE_RATE = exports.DEFAULT_NARRATION_WPM = void 0;
exports.wpmToSapiRate = wpmToSapiRate;
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const util_1 = require("util");
const run = (0, util_1.promisify)(child_process_1.execFile);
const WAV_SAMPLE_RATE = 22050;
exports.WAV_SAMPLE_RATE = WAV_SAMPLE_RATE;
class TtsService {
    probed = null;
    /** Cached — enumerating voices shells out, and the set does not change while the app runs. */
    async probe(force = false) {
        if (this.probed && !force)
            return this.probed;
        this.probed = await this.detect();
        return this.probed;
    }
    async detect() {
        if (process.platform === 'darwin') {
            const voices = await this.macVoices();
            return voices.length
                ? { available: true, engine: 'say', voices }
                : { available: false, engine: null, voices: [], reason: 'macOS reported no installed speech voices.' };
        }
        if (process.platform === 'win32') {
            const voices = await this.windowsVoices();
            return voices.length
                ? { available: true, engine: 'sapi', voices }
                : { available: false, engine: null, voices: [], reason: 'Windows reported no installed speech voices.' };
        }
        const voices = await this.espeakVoices();
        return voices.length
            ? { available: true, engine: 'espeak-ng', voices }
            : {
                available: false,
                engine: null,
                voices: [],
                reason: 'No speech engine found. Install espeak-ng to narrate walkthroughs on this machine.',
            };
    }
    /** `say -v '?'` prints "Name    lang_REGION  # example sentence". */
    async macVoices() {
        try {
            const { stdout } = await run('say', ['-v', '?'], { timeout: 10_000, maxBuffer: 1 << 20 });
            return stdout
                .split('\n')
                .map((line) => {
                const match = /^(.+?)\s{2,}([a-z]{2}[-_][A-Z]{2})\s*#/.exec(line.trim());
                if (!match)
                    return null;
                return { id: match[1].trim(), label: match[1].trim(), language: match[2].replace('_', '-') };
            })
                .filter((v) => v !== null);
        }
        catch {
            return [];
        }
    }
    async windowsVoices() {
        const script = 'Add-Type -AssemblyName System.Speech;' +
            '(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ' +
            'ForEach-Object { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture.Name }';
        try {
            const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
                timeout: 15_000,
                maxBuffer: 1 << 20,
            });
            return stdout
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => {
                const [name, culture] = line.split('|');
                return name ? { id: name, label: name, language: culture || 'en-US' } : null;
            })
                .filter((v) => v !== null);
        }
        catch {
            return [];
        }
    }
    async espeakVoices() {
        try {
            const { stdout } = await run('espeak-ng', ['--voices'], { timeout: 10_000, maxBuffer: 1 << 20 });
            return stdout
                .split('\n')
                .slice(1)
                .map((line) => {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 4)
                    return null;
                return { id: parts[3], label: parts[3], language: parts[1] };
            })
                .filter((v) => v !== null);
        }
        catch {
            return [];
        }
    }
    /**
     * Narrate one step to a WAV file. WAV rather than the platform's native container because
     * the muxer path decodes it with Web Audio, which will not touch AIFF.
     */
    async synthesize(options) {
        const probe = await this.probe();
        if (!probe.available)
            throw new Error(probe.reason ?? 'No speech engine available on this machine.');
        const text = options.text.trim();
        if (!text)
            throw new Error('nothing to narrate');
        await fs_1.default.promises.mkdir(path_1.default.dirname(options.outFile), { recursive: true });
        if (probe.engine === 'say') {
            const args = ['-o', options.outFile, '--data-format=LEI16@22050'];
            if (options.voice)
                args.push('-v', options.voice);
            if (options.rate)
                args.push('-r', String(options.rate));
            // Text last, as its own argv entry — never concatenated into a command string.
            args.push(text);
            await run('say', args, { timeout: 120_000 });
            return;
        }
        if (probe.engine === 'sapi') {
            await this.synthesizeWindows(text, options);
            return;
        }
        const args = ['-w', options.outFile];
        if (options.voice)
            args.push('-v', options.voice);
        if (options.rate)
            args.push('-s', String(options.rate));
        args.push(text);
        await run('espeak-ng', args, { timeout: 120_000 });
    }
    /**
     * PowerShell has no argv for arbitrary text that survives quoting reliably, so the prose goes
     * to a UTF-8 file and the script reads it. Nothing the model wrote is ever parsed as command.
     */
    async synthesizeWindows(text, options) {
        const scratch = path_1.default.join(os_1.default.tmpdir(), `gt-tts-${(0, crypto_1.randomUUID)()}.txt`);
        await fs_1.default.promises.writeFile(scratch, text, 'utf8');
        try {
            const script = [
                'Add-Type -AssemblyName System.Speech;',
                '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
                options.voice ? `$s.SelectVoice($env:GT_VOICE);` : '',
                options.rate ? `$s.Rate = [int]$env:GT_RATE;` : '',
                `$s.SetOutputToWaveFile($env:GT_OUT);`,
                `$s.Speak([System.IO.File]::ReadAllText($env:GT_IN, [System.Text.Encoding]::UTF8));`,
                '$s.Dispose();',
            ].join(' ');
            await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
                timeout: 120_000,
                env: {
                    ...process.env,
                    GT_IN: scratch,
                    GT_OUT: options.outFile,
                    GT_VOICE: options.voice ?? '',
                    // SAPI rate is -10..10, not words per minute. Map from the same wpm the UI offers.
                    GT_RATE: String(wpmToSapiRate(options.rate)),
                },
            });
        }
        finally {
            await fs_1.default.promises.rm(scratch, { force: true }).catch(() => undefined);
        }
    }
}
/**
 * SAPI's rate is a -10..10 scale centred on roughly 200 wpm, not a wpm value. Mapping keeps one
 * unit in the UI across all three platforms rather than exposing the platform's own scale.
 */
function wpmToSapiRate(wpm) {
    if (!wpm)
        return 0;
    const clamped = Math.max(100, Math.min(300, wpm));
    return Math.round(((clamped - 200) / 100) * 10);
}
/** Default narration pace. Slower than every platform default, which suits a walkthrough. */
exports.DEFAULT_NARRATION_WPM = 170;
exports.ttsService = new TtsService();
//# sourceMappingURL=TtsService.js.map