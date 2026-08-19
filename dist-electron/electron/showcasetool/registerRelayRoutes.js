"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRelayRoutes = registerRelayRoutes;
const electron_1 = require("electron");
const channels_1 = require("../ipc/channels");
const appWindow_1 = require("./appWindow");
const ExtensionRelayService_1 = require("../services/ExtensionRelayService");
const AiProviderService_1 = require("../services/AiProviderService");
const GuideSessionStore_1 = require("./GuideSessionStore");
const GuideStore_1 = require("./GuideStore");
const MachineRecorderService_1 = require("./MachineRecorderService");
const HarvestDestinations_1 = require("./HarvestDestinations");
const cli_locator_1 = require("../agent-bridge/cli-locator");
const headless_runner_1 = require("../agent-bridge/headless-runner");
const RedactionService_1 = require("./RedactionService");
const GeneratorService_1 = require("./GeneratorService");
/**
 * The relay's endpoints (§7.1, §7.6). Everything the extension can ask the app to do is
 * enumerated here — recording, guide loading, progress, AI repair, and harvest delivery.
 */
function notifyRenderer() {
    for (const window of electron_1.BrowserWindow.getAllWindows()) {
        window.webContents.send(channels_1.CHANNELS.events.sessionsChanged);
    }
}
function requireString(body, key) {
    const value = body[key];
    if (typeof value !== 'string' || !value)
        throw new Error(`${key} is required`);
    return value;
}
function registerRelayRoutes() {
    // ---------------------------------------------------------------- recording
    ExtensionRelayService_1.extensionRelay.register({
        method: 'POST',
        path: '/session/start',
        handle: (body) => {
            /**
             * The mirror of the guard in MachineRecorderService.start. Two recorders writing steps
             * into two sessions at once is confusing to the Maker and ambiguous in the library, and
             * the extension has no way to know this app is capturing a desktop window.
             */
            if (MachineRecorderService_1.machineRecorder.status().recording) {
                throw new Error('1ShowcaseTool is recording a desktop window. Stop that recording before recording in the browser.');
            }
            const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Untitled flow';
            const sessionId = GuideSessionStore_1.guideSessionStore.create(title);
            notifyRenderer();
            const rules = RedactionService_1.redactionService.listRules('project').map((rule) => ({
                kind: rule.kind,
                pattern: rule.pattern,
                placeholder: rule.placeholder,
            }));
            return { sessionId, rules };
        },
    });
    ExtensionRelayService_1.extensionRelay.register({
        method: 'POST',
        path: '/session/step',
        handle: (body) => {
            const sessionId = requireString(body, 'sessionId');
            const step = body.step;
            if (!step || typeof step !== 'object')
                throw new Error('step is required');
            const id = GuideSessionStore_1.guideSessionStore.appendStep(sessionId, step);
            return { stepId: id };
        },
    });
    ExtensionRelayService_1.extensionRelay.register({
        method: 'POST',
        path: '/session/stop',
        handle: (body) => {
            GuideSessionStore_1.guideSessionStore.stop(requireString(body, 'sessionId'));
            notifyRenderer();
            /**
             * Stop was pressed in the popup, with Chrome in front — the app is behind it, opening the
             * finished recording on a window nobody can see. The push above is what App routes on; this
             * is what makes that routing visible. Only on stop: a start is the Maker settling into the
             * page they are about to record, and the last thing they need is a window over it.
             */
            (0, appWindow_1.surfaceAppWindow)();
            return { ok: true };
        },
    });
    // ---------------------------------------------------------------- replay
    /**
     * Replayable guides only (docs/machine-record-plan.md §8, guard 2). A guide made from a
     * desktop-window recording has pixel coordinates and no selectors, so the overlay could not
     * drive it — it must never appear in the popup's list to be chosen in the first place.
     */
    ExtensionRelayService_1.extensionRelay.register({
        method: 'GET',
        path: '/guides',
        handle: () => ({
            guides: GuideStore_1.guideStore
                .list()
                .filter((g) => g.replayable)
                .map((g) => ({ id: g.id, title: g.title, stepCount: g.stepCount })),
        }),
    });
    ExtensionRelayService_1.extensionRelay.register({
        method: 'GET',
        path: '/guide',
        handle: (_body, url) => {
            const id = url.searchParams.get('id');
            if (!id)
                throw new Error('id is required');
            // Checked here too, not only in the listing: an id can arrive from anywhere.
            if (!GuideStore_1.guideStore.isReplayable(id)) {
                throw new Error('That guide was recorded from a desktop window, so it cannot be followed in the browser. Open it in 1ShowcaseTool instead.');
            }
            const result = GuideStore_1.guideStore.getOrError(id);
            if (!result.ok)
                throw new Error(result.error);
            return { guide: result.guide, progress: GuideStore_1.guideStore.progress(id) };
        },
    });
    /**
     * Ask-this-guide. Overlay and app only — the HTML export has no network and must stay
     * that way. One explicit question, grounded on the guide's prose.
     */
    ExtensionRelayService_1.extensionRelay.register({
        method: 'POST',
        path: '/guide/ask',
        handle: async (body) => {
            const guideId = requireString(body, 'guideId');
            const question = requireString(body, 'question');
            if (!GuideStore_1.guideStore.isReplayable(guideId))
                throw new Error('unknown or non-replayable guide');
            const result = GuideStore_1.guideStore.getOrError(guideId);
            if (!result.ok)
                throw new Error(result.error);
            const answer = await GeneratorService_1.generatorService.askGuide(result.guide, question);
            if (!answer.ok)
                throw new Error(answer.error);
            return { answer: answer.answer };
        },
    });
    /**
     * A check-run health report (docs/competitor-features.md §14). Sent only when the Maker
     * explicitly ran a guide in check mode — the extension never reports a Follower's replay
     * (§7.6). Anchor metadata only: which resolution rung held per step, nothing about who
     * walked it or what the page contained. Report-only; nothing here can edit the guide.
     */
    ExtensionRelayService_1.extensionRelay.register({
        method: 'POST',
        path: '/guide/health',
        handle: (body) => {
            const guideId = requireString(body, 'guideId');
            // Same shape of guard as /guide: only a replayable guide can have been checked.
            if (!GuideStore_1.guideStore.isReplayable(guideId))
                throw new Error('unknown or non-replayable guide');
            const health = GuideStore_1.guideStore.saveHealth(guideId, body.steps);
            for (const window of electron_1.BrowserWindow.getAllWindows()) {
                window.webContents.send(channels_1.CHANNELS.events.guideHealthChanged, { guideId });
            }
            return { ok: true, checkedAt: health.checkedAt };
        },
    });
    /**
     * A re-shot step screenshot from a check run (the stale-step refresh). Stored as a pending
     * proposal only: this handler must never write the guide — the new pixels stay unreachable
     * from every export until the Maker reviews and applies them in the app. The frame arrives
     * already scrubbed by the in-page pass, and the review gate here is the apply step itself.
     */
    ExtensionRelayService_1.extensionRelay.register({
        method: 'POST',
        path: '/guide/reshoot',
        handle: (body) => {
            const guideId = requireString(body, 'guideId');
            const stepId = requireString(body, 'stepId');
            const screenshot = requireString(body, 'screenshot');
            if (!GuideStore_1.guideStore.isReplayable(guideId))
                throw new Error('unknown or non-replayable guide');
            const targetRect = body.targetRect && typeof body.targetRect === 'object' ? body.targetRect : null;
            GuideStore_1.guideStore.stashRefresh(guideId, stepId, screenshot, targetRect);
            for (const window of electron_1.BrowserWindow.getAllWindows()) {
                window.webContents.send(channels_1.CHANNELS.events.guideRefreshChanged, { guideId });
            }
            return { ok: true };
        },
    });
    ExtensionRelayService_1.extensionRelay.register({
        method: 'POST',
        path: '/progress',
        handle: (body) => {
            const guideId = requireString(body, 'guideId');
            const stepId = requireString(body, 'stepId');
            const state = requireString(body, 'state');
            if (state !== 'pending' && state !== 'done' && state !== 'skipped')
                throw new Error('invalid state');
            GuideStore_1.guideStore.setProgress(guideId, stepId, state);
            return { ok: true };
        },
    });
    /**
     * AI repair (§7.6). Takes an accessibility snapshot — roles and labels, never values,
     * never the DOM, never a screenshot — and asks which element matches the step's intent.
     */
    ExtensionRelayService_1.extensionRelay.register({
        method: 'POST',
        path: '/repair',
        handle: async (body) => {
            const snapshot = requireString(body, 'snapshot');
            const intent = requireString(body, 'intent');
            const prompt = [
                'A guide step could not be located on the page. Here are the interactive elements currently on screen:',
                '',
                snapshot,
                '',
                `The step needs: ${intent}`,
                '',
                'Reply with the ref of the single best matching element, exactly as written above, and nothing else.',
                'If none of them plausibly match, reply with the word NONE.',
            ].join('\n');
            const text = await runOneShot('You match a described UI target to one element in an accessibility snapshot. Reply with a ref or NONE.', prompt);
            if (!text)
                return { selector: null };
            const answer = text.trim().split('\n')[0].trim();
            if (!answer || /^none$/i.test(answer))
                return { selector: null };
            // Only hand back something that actually appeared in the snapshot we sent.
            return { selector: snapshot.includes(answer) ? answer : null };
        },
    });
    ExtensionRelayService_1.extensionRelay.register({
        method: 'POST',
        path: '/explain',
        handle: async (body) => {
            const snapshot = requireString(body, 'snapshot');
            const question = requireString(body, 'question');
            const text = await runOneShot('You help someone who is stuck partway through a setup flow. Answer in at most three sentences, plainly.', [`They are stuck on: ${question}`, '', 'Elements currently on screen:', snapshot].join('\n'));
            return { text: text ?? '' };
        },
    });
    /**
     * Value harvest delivery (§7.6). This endpoint is the *only* thing in the app that
     * accepts a Follower's value, and it neither logs nor stores it — it writes it through to
     * the configured destination and returns a description of where it went.
     */
    ExtensionRelayService_1.extensionRelay.register({
        method: 'POST',
        path: '/harvest',
        handle: async (body) => {
            const target = requireString(body, 'target');
            const value = body.value;
            if (typeof value !== 'string' || !value)
                throw new Error('value is required');
            const { destination } = await (0, HarvestDestinations_1.deliver)(target, value);
            return { destination };
        },
    });
}
/** One-shot completion for repair/explain, preferring the CLI exactly as generation does. */
async function runOneShot(system, prompt) {
    const agent = await (0, cli_locator_1.locateAgent)();
    if (agent) {
        const result = await (0, headless_runner_1.runHeadless)(agent, `${system}\n\n${prompt}`);
        if (result.ok)
            return result.text;
    }
    const byok = await AiProviderService_1.aiProviderService.complete(system, prompt);
    return byok.ok ? byok.text : null;
}
//# sourceMappingURL=registerRelayRoutes.js.map