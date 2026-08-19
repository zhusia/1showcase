"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generatorService = exports.GeneratorService = exports.AUTO_TRANSPORT_ID = void 0;
const crypto_1 = require("crypto");
const zod_1 = require("zod");
const cli_locator_1 = require("../agent-bridge/cli-locator");
const headless_runner_1 = require("../agent-bridge/headless-runner");
const db_1 = require("../db");
const AiProviderService_1 = require("../services/AiProviderService");
const LicenseService_1 = require("../services/LicenseService");
const annotations_1 = require("./annotations");
const customize_1 = require("./customize");
const entitlements_1 = require("./entitlements");
const music_1 = require("./music");
const GuideSessionStore_1 = require("./GuideSessionStore");
const GuideStore_1 = require("./GuideStore");
const RedactionService_1 = require("./RedactionService");
const askGuide_1 = require("./askGuide");
const schema_1 = require("./schema");
/** Sentinel for "CLI first, then BYOK" — stored as the preferred transport id. */
exports.AUTO_TRANSPORT_ID = 'auto';
const PREFERRED_TRANSPORT_KEY = 'generator.preferred-transport';
/**
 * The audit prompt. Deliberately asks for problems a *reader* would hit, not for a rewrite —
 * the value is a second pair of eyes on prose the Maker has stopped being able to read freshly.
 */
const AUDIT_SYSTEM_PROMPT = `You review a step-by-step guide on behalf of someone following it for the first time.

Report only problems a reader would actually hit: a step that assumes knowledge the guide never gave them, a jump where something happened between two steps that is not written down, a value referred to but never produced, a prerequisite that should have been stated up front, or an instruction whose wording could be followed two different ways.

Do not rewrite the guide. Do not comment on tone, length or formatting. If a step is fine, say nothing about it.

Reply with JSON only:
{"summary":"one sentence on whether a first-timer could complete this","findings":[{"stepId":"<id or omit if it is about the guide as a whole>","severity":"blocker|confusing|nit","note":"what a reader would hit, in one sentence"}]}

An empty findings array is a valid and good answer.`;
const AuditFindingSchema = zod_1.z.object({
    stepId: zod_1.z.string().optional(),
    severity: zod_1.z.enum(['blocker', 'confusing', 'nit']).catch('nit'),
    note: zod_1.z.string().min(1).max(400),
});
const AuditSchema = zod_1.z.object({
    summary: zod_1.z.string().max(400).default(''),
    findings: zod_1.z.array(AuditFindingSchema).max(40).default([]),
});
const BROWSER_SYSTEM_PROMPT = `You write setup walkthroughs from a recorded browser session.

You receive a redacted event trace: every step the Maker performed, with the selectors that
resolved uniquely, an accessibility anchor, and the page URL pattern. Secrets have already
been destroyed or replaced with named placeholders before you see any of this — treat a
placeholder like <YOUR_CLIENT_ID> as the literal text the Follower must paste, and never
invent a real-looking value in its place.

Your output is a single JSON object and nothing else. No prose before it, no markdown fence
around it, no trailing commentary.

Rules for the JSON:
- Emit exactly one step per input step, in the same order, reusing the given "id",
  "urlPattern", "selectors", "a11y", and "screenshot" verbatim. Do not merge, split,
  reorder, invent, or drop steps.
- "title" is a short imperative instruction ("Create a Google Cloud project").
- "body" tells the Follower what to do, in the second person, naming what they will see on
  screen. Two or three sentences at most.
- "why" explains why the step exists. Without the source repository you are inferring, so
  say what the step accomplishes rather than asserting implementation detail you cannot see.
  Omit "why" entirely rather than guessing at specifics.
- "verify" is how the Follower knows the step worked. Propose one when you are confident and
  omit it otherwise — a wrong verify blocks someone who did everything right. The Maker
  confirms these before the guide ships.
- Never place a captured value, secret, or credential anywhere in the output.`;
/**
 * The same job from a desktop recording (docs/machine-record-plan.md §9).
 *
 * Every structural rule is identical — one step in, one step out, same ids, never a value.
 * What changes is the premise: there is no DOM here, so a model handed the browser prompt
 * invents selectors and URLs it cannot possibly have seen, and states them with confidence.
 */
const MACHINE_SYSTEM_PROMPT = `You write walkthroughs from a recorded desktop application session.

You receive a sequence of screenshots of a single application window, in order. For each one
you get the window's title at that moment and, often, a short note the person recording typed
to say what they were doing. There are no URLs, no selectors, and no page structure — this was
a native application window, not a web page, and nothing about its internals was captured.

Your output is a single JSON object and nothing else. No prose before it, no markdown fence
around it, no trailing commentary.

Rules for the JSON:
- Emit exactly one step per input step, in the same order, reusing the given "id" verbatim.
  Do not merge, split, reorder, invent, or drop steps.
- "title" is a short imperative instruction ("Open the connection settings").
- "body" tells the reader what to do, in the second person, describing what they will see in
  the application — the panel, the button label, the menu path. Two or three sentences at most.
- The recorder's note for a step is the strongest evidence you have of intent. Prefer it over
  anything you infer from the window title.
- Never name a CSS selector, an element id, a URL, or any web concept. None of that exists here.
  Do not describe the screenshot's pixel layout either ("the button at 400,220") — name what
  the control is called.
- "why" explains what the step accomplishes. You are inferring, so stay at the level you can
  actually support, and omit "why" entirely rather than guessing at specifics.
- "verify" may only be {"kind":"manual","value":"..."} — there is nothing here to assert a URL
  or a selector against. Omit it unless the note gives you something concrete to check.
- Never place a captured value, secret, or credential anywhere in the output.`;
function systemPromptFor(source) {
    return source === 'machine' ? MACHINE_SYSTEM_PROMPT : BROWSER_SYSTEM_PROMPT;
}
class GeneratorService {
    cachedAgents = [];
    cachedInventory = [];
    agentProbed = false;
    /**
     * Detect supported CLIs and BYOK, then activate the Maker's saved choice when it is present.
     * `auto` (or a missing choice) means first available CLI, then BYOK. Every route produces guide.json.
     */
    async routes() {
        const inventory = await this.inventory();
        const available = [];
        for (const item of inventory) {
            if (item.state !== 'detected')
                continue;
            available.push({ kind: 'cli', label: item.label, id: `cli:${item.id}` });
        }
        if (await AiProviderService_1.aiProviderService.isReady()) {
            const config = AiProviderService_1.aiProviderService.getConfig();
            available.push({
                kind: 'byok',
                label: config ? `${providerLabel(config.id)} (${config.model})` : 'BYOK',
                id: `byok:${config?.id ?? 'unknown'}`,
            });
        }
        const preferred = this.preferredTransportId() ?? exports.AUTO_TRANSPORT_ID;
        const active = preferred === exports.AUTO_TRANSPORT_ID
            ? available[0] ?? null
            : available.find((route) => route.id === preferred) ?? available[0] ?? null;
        const agents = inventory.map((item) => ({
            id: item.id,
            label: item.label,
            state: item.state,
            version: item.version,
            routeId: item.state === 'detected' ? `cli:${item.id}` : null,
        }));
        return { active, available, agents, preferred };
    }
    /**
     * Persist the explicit choice so every generation and audit uses it after navigation/restart.
     * Accepts `auto` or a concrete `cli:…` / `byok:…` id.
     */
    async selectTransport(routeId) {
        if (typeof routeId !== 'string' || !routeId.trim())
            throw new Error('transport id is required');
        const id = routeId.trim();
        if (id === exports.AUTO_TRANSPORT_ID) {
            this.writePreferred(exports.AUTO_TRANSPORT_ID);
            return this.routes();
        }
        // Refresh so a just-rescanned CLI is eligible; then require it still to be available.
        const before = await this.routes();
        const active = before.available.find((route) => route.id === id);
        if (!active)
            throw new Error('that AI transport is no longer available — rescan and choose another');
        this.writePreferred(id);
        return this.routes();
    }
    writePreferred(routeId) {
        (0, db_1.getDb)()
            .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
            .run(PREFERRED_TRANSPORT_KEY, routeId);
    }
    preferredTransportId() {
        const row = (0, db_1.getDb)().prepare(`SELECT value FROM settings WHERE key = ?`).get(PREFERRED_TRANSPORT_KEY);
        return row?.value ?? null;
    }
    async agents() {
        if (!this.agentProbed)
            await this.refreshAgentCache();
        return this.cachedAgents;
    }
    async inventory() {
        if (!this.agentProbed)
            await this.refreshAgentCache();
        return this.cachedInventory;
    }
    async refreshAgentCache() {
        this.cachedInventory = await (0, cli_locator_1.listAgentInventory)();
        // One probe pass: locateAgents would re-scan PATH and re-run --version.
        this.cachedAgents = this.cachedInventory
            .filter((item) => item.state === 'detected' && !!item.binPath)
            .map((item) => {
            const spec = cli_locator_1.AGENT_SPECS.find((entry) => entry.id === item.id);
            return { spec, binPath: item.binPath, version: item.version ?? '' };
        });
        this.agentProbed = true;
    }
    async agentForRoute(routeId) {
        const specId = routeId.startsWith('cli:') ? routeId.slice(4) : routeId;
        return (await this.agents()).find((agent) => agent.spec.id === specId) ?? null;
    }
    /** Forget the cached CLI probe — the user may have installed one since launch. */
    rescanTransports() {
        this.agentProbed = false;
        this.cachedAgents = [];
        this.cachedInventory = [];
    }
    async generate(options, signal) {
        // The gate. Nothing is generated for a session whose redaction pass is outstanding,
        // which is also what guarantees the model never sees an unreviewed secret (§7.2).
        try {
            RedactionService_1.redactionService.assertAcknowledged(options.sessionId);
        }
        catch (err) {
            return { ok: false, error: err.message };
        }
        const session = GuideSessionStore_1.guideSessionStore.get(options.sessionId);
        if (!session)
            return { ok: false, error: 'session not found' };
        let replacementId;
        if (options.replaceGuideId?.trim()) {
            replacementId = options.replaceGuideId.trim();
            const existing = GuideStore_1.guideStore.getOrError(replacementId);
            if (!existing.ok)
                return { ok: false, error: 'the guide being regenerated no longer exists' };
            if (GuideStore_1.guideStore.sessionIdOf(replacementId) !== options.sessionId) {
                return { ok: false, error: 'the guide being regenerated does not belong to this recording' };
            }
            if (existing.guide.translationOf) {
                return { ok: false, error: 'regenerate the primary guide rather than one of its translations' };
            }
        }
        const steps = session.steps.filter((s) => !s.dropped);
        if (!steps.length)
            return { ok: false, error: 'session has no steps left after the review pass' };
        const chosen = (0, customize_1.normalizeCustomize)(options.customize ?? session.customize);
        GuideSessionStore_1.guideSessionStore.setPrompt(options.sessionId, options.prompt, options.audience);
        /**
         * Persist what the Maker asked for, then generate from what their licence allows. Storing the
         * clamped copy instead would quietly discard a colour or a language the moment they picked it,
         * and buying Pro afterwards would not bring it back.
         */
        GuideSessionStore_1.guideSessionStore.setCustomize(options.sessionId, chosen);
        const pro = LicenseService_1.licenseService.isPro();
        const customize = (0, entitlements_1.applyEntitlement)(chosen, pro);
        const clamped = pro ? [] : (0, entitlements_1.clampedFields)(chosen);
        const userPrompt = buildPrompt(session, steps, options, customize);
        const { active } = await this.routes();
        if (!active) {
            return {
                ok: false,
                error: 'no AI transport available — install an agent CLI or add an API key in settings',
            };
        }
        const raw = await this.run(active, userPrompt, signal, systemPromptFor(session.source));
        if (!raw.ok)
            return { ok: false, error: raw.error };
        const guide = this.assemble(raw.text, session, steps, options, active.id, customize, replacementId);
        if (!guide.ok)
            return guide;
        GuideStore_1.guideStore.save(guide.guide, options.sessionId);
        GuideSessionStore_1.guideSessionStore.setStatus(options.sessionId, 'generated');
        const warnings = [];
        /**
         * Say so rather than silently ignoring the panel. A setting that appears to save and then has
         * no effect on the output reads as a bug, not as an upsell.
         */
        if (clamped.length) {
            warnings.push(`${clamped.join(', ')} ${clamped.length === 1 ? 'is a Pro setting' : 'are Pro settings'} — this guide used ` +
                'the defaults. Add a licence in Settings to apply your own.');
        }
        /**
         * Extra languages are separate guides, not a field inside one. A Follower opens the guide
         * in their language and every export, replay, and progress record works unchanged — and a
         * translation that comes out wrong can be deleted without touching the original.
         */
        const variants = [];
        for (const code of customize.languages.codes.slice(1)) {
            const translated = await this.translate(guide.guide, code, active, signal);
            if (!translated.ok) {
                warnings.push(`${(0, customize_1.languageName)(code)}: ${translated.error}`);
                continue;
            }
            GuideStore_1.guideStore.save(translated.guide, options.sessionId);
            variants.push({ id: translated.guide.id, language: code, title: translated.guide.title });
        }
        return { ok: true, guide: guide.guide, transport: active.id, variants, warnings };
    }
    /**
     * One completion per extra language. Only the authored prose travels — selectors, URL
     * patterns, and placeholders stay verbatim, because a translated `<YOUR_CLIENT_ID>` is a
     * string the Follower would then paste and wonder why nothing worked.
     */
    async translate(base, code, route, signal) {
        const strings = {
            title: base.title,
            intent: base.intent,
        };
        base.prerequisites.forEach((item, i) => {
            strings[`prereq.${i}`] = item;
        });
        for (const step of base.steps) {
            strings[`${step.id}.title`] = step.title;
            if (step.body)
                strings[`${step.id}.body`] = step.body;
            if (step.why)
                strings[`${step.id}.why`] = step.why;
            if (step.verify?.kind === 'manual' && step.verify.value)
                strings[`${step.id}.verify`] = step.verify.value;
            step.annotations.forEach((annotation, i) => {
                // Badge labels are step numbers; only callout text is prose worth translating.
                if (annotation.kind !== 'badge' && annotation.label)
                    strings[`${step.id}.ann.${i}`] = annotation.label;
            });
        }
        const prompt = [
            `Translate the values of this JSON object into ${(0, customize_1.languageName)(code)} (${code}).`,
            '',
            'Rules:',
            '- Return one JSON object with exactly the same keys. No extra keys, none missing.',
            '- Translate values only. Never translate a key.',
            '- Leave placeholders like <YOUR_CLIENT_ID>, URLs, code identifiers, and product names exactly as they are.',
            '- Keep the register of a setup guide addressed to one person: direct, second person, no filler.',
            '- Return the JSON object only, with no prose or fences around it.',
            '',
            JSON.stringify(strings, null, 2),
        ].join('\n');
        const raw = await this.run(route, prompt, signal);
        if (!raw.ok)
            return { ok: false, error: raw.error };
        const extracted = extractJson(raw.text);
        if (!extracted)
            return { ok: false, error: 'the model did not return JSON' };
        let translated;
        try {
            translated = JSON.parse(extracted);
        }
        catch (err) {
            return { ok: false, error: `malformed JSON: ${err.message}` };
        }
        // A key the model dropped falls back to the original: a guide half in English still
        // works, whereas a guide with an empty step title does not.
        const pick = (key, fallback) => {
            const value = translated[key];
            return typeof value === 'string' && value.trim() ? value.trim() : fallback;
        };
        const candidate = {
            ...base,
            id: `${base.id}--${code.toLowerCase()}`,
            language: code,
            translationOf: base.id,
            title: pick('title', base.title),
            intent: pick('intent', base.intent),
            prerequisites: base.prerequisites.map((item, i) => pick(`prereq.${i}`, item)),
            steps: base.steps.map((step) => ({
                ...step,
                title: pick(`${step.id}.title`, step.title),
                body: step.body ? pick(`${step.id}.body`, step.body) : step.body,
                why: step.why ? pick(`${step.id}.why`, step.why) : step.why,
                verify: step.verify?.kind === 'manual' && step.verify.value
                    ? { kind: 'manual', value: pick(`${step.id}.verify`, step.verify.value) }
                    : step.verify,
                annotations: step.annotations.map((annotation, i) => annotation.kind !== 'badge' && annotation.label
                    ? { ...annotation, label: pick(`${step.id}.ann.${i}`, annotation.label) }
                    : annotation),
            })),
        };
        // Back through the validator: a translation is model output like any other.
        const parsed = (0, schema_1.parseGuide)(JSON.parse(JSON.stringify(candidate)));
        return parsed.ok ? { ok: true, guide: parsed.guide } : { ok: false, error: parsed.error };
    }
    /**
     * Audit a finished guide (docs/competitor-features.md §2.8).
     *
     * Supademo sells this as "AI Demo Audit". Ours runs on the same transport generation used,
     * so it costs the user's own quota or their own key and nothing leaves the machine that the
     * guide itself did not already contain.
     *
     * It reads **only the authored prose** — never the screenshots and never the selectors. Two
     * reasons: a screenshot round-trip is expensive on a BYOK key, and the question being asked
     * ("could a first-timer follow these words?") is answerable from the words. It reports; it
     * never edits. A model that rewrites a step it misread would be worse than one that flags it.
     */
    async audit(guideId, signal) {
        const loaded = GuideStore_1.guideStore.getOrError(guideId);
        if (!loaded.ok)
            return { ok: false, error: loaded.error };
        const guide = loaded.guide;
        // The gate, like every other downstream path.
        const sessionId = GuideStore_1.guideStore.sessionIdOf(guideId);
        if (sessionId)
            RedactionService_1.redactionService.assertAcknowledged(sessionId);
        const { active } = await this.routes();
        if (!active) {
            return { ok: false, error: 'no AI transport available — install an agent CLI or add an API key in settings' };
        }
        const prose = guide.steps.map((step, i) => ({
            n: i + 1,
            id: step.id,
            title: step.title,
            body: step.body,
            why: step.why,
            hasScreenshot: !!step.screenshot,
            producesValue: !!step.outputs?.length,
        }));
        const prompt = [
            `Title: ${guide.title}`,
            guide.intent ? `Intent: ${guide.intent}` : '',
            guide.audience ? `Audience: ${guide.audience}` : '',
            `Prerequisites: ${guide.prerequisites.length ? guide.prerequisites.join('; ') : '(none stated)'}`,
            '',
            'Steps:',
            JSON.stringify(prose, null, 1),
        ]
            .filter(Boolean)
            .join('\n');
        const raw = await this.run(active, prompt, signal, AUDIT_SYSTEM_PROMPT);
        if (!raw.ok)
            return { ok: false, error: raw.error };
        const extracted = extractJson(raw.text);
        if (!extracted)
            return { ok: false, error: 'the model did not return JSON' };
        let candidate;
        try {
            candidate = JSON.parse(extracted);
        }
        catch {
            return { ok: false, error: 'the model returned malformed JSON' };
        }
        const parsed = AuditSchema.safeParse(candidate);
        if (!parsed.success)
            return { ok: false, error: 'the model did not return a usable audit' };
        // Drop findings that name a step which does not exist — a hallucinated id would render
        // as a finding nobody can act on.
        const ids = new Set(guide.steps.map((s) => s.id));
        const findings = parsed.data.findings.filter((f) => !f.stepId || ids.has(f.stepId));
        return { ok: true, transport: active.id, summary: parsed.data.summary, findings };
    }
    /**
     * Compose a studio score through the connected transport.
     *
     * The request is re-parsed with a strict schema before anything is sent, so a renderer
     * that tried to smuggle a path or a sample cannot reach the model. This method does not
     * look up a session — it has nothing to look up. On free, or with no transport, the
     * caller falls through to the mood-table composer; this is never a dependency.
     */
    async composeScore(raw, signal) {
        const request = (0, music_1.parseScoreRequest)(raw);
        if (!request.ok)
            return { ok: false, error: request.error };
        if (!LicenseService_1.licenseService.isPro()) {
            return { ok: false, error: 'Compose with AI is a Pro setting — the mood tables will be used instead.' };
        }
        const { active } = await this.routes();
        if (!active) {
            return { ok: false, error: 'no AI transport available — install an agent CLI or add an API key in settings' };
        }
        const system = [
            'You compose a short musical score description for a product film.',
            'Reply with one JSON object and nothing else. No prose, no fences.',
            'The object must match this shape exactly:',
            '{"version":1,"tempo":<56-140>,"key":"<one of C,C#,D,Eb,E,F,F#,G,Ab,A,Bb,B,Cm,C#m,Dm,Ebm,Em,Fm,F#m,Gm,G#m,Am,Bbm,Bm>","mood":"<calm|warm|focus|bright|epic|night>","sections":[{"atMs":<number>,"energy":<0-1>,"chords":["I"|"ii"|"iii"|"IV"|"V"|"vi"|"bVII"|"i"|"III"|"iv"|"v"|"VI"|"VII"],"voices":["pad"|"bass"|"arp"|"pulse"|"shimmer"|"riser"]}],"hits":[{"atMs":<number>,"kind":"riser"|"resolve"|"lift"}],"seed":<int>}',
            'Rules:',
            '- sections.atMs must be 0 or one of the supplied cuts/arrivals. Never invent a time mid-shot.',
            '- hits of kind riser end exactly on an arrival time. A lift may follow 80ms later. One resolve near the end.',
            '- 1 to 64 sections, at most 32 hits, at most 5 voices per section, at most 8 chords per section.',
            '- No other keys. No paths. No samples.',
        ].join('\n');
        const user = [
            'Compose a score for this film shape:',
            JSON.stringify(request.request),
        ].join('\n');
        const rawReply = await this.run(active, user, signal, system);
        if (!rawReply.ok)
            return { ok: false, error: rawReply.error };
        const extracted = extractJson(rawReply.text);
        if (!extracted)
            return { ok: false, error: 'the model did not return JSON' };
        let candidate;
        try {
            candidate = JSON.parse(extracted);
        }
        catch {
            return { ok: false, error: 'the model returned malformed JSON' };
        }
        const parsed = (0, music_1.parseScore)(candidate);
        if (!parsed.ok)
            return { ok: false, error: parsed.error };
        if (!Number.isFinite(parsed.score.seed)) {
            parsed.score = { ...parsed.score, seed: request.request.seed };
        }
        return { ok: true, score: parsed.score, transport: active.id };
    }
    /**
     * One explicit question about a guide. Grounded on the guide's prose. Never screenshots.
     */
    async askGuide(guide, question, signal) {
        const asked = question.trim();
        if (!asked)
            return { ok: false, error: 'Ask a question first.' };
        const routes = await this.routes();
        const active = routes.active;
        if (!active)
            return { ok: false, error: 'No AI transport is configured.' };
        const { system, user } = (0, askGuide_1.askPrompt)(guide, asked);
        const reply = await this.run(active, user, signal, system);
        if (!reply.ok)
            return reply;
        return { ok: true, answer: reply.text.trim() };
    }
    async run(route, prompt, signal, system = BROWSER_SYSTEM_PROMPT) {
        if (route.kind === 'cli') {
            const agent = await this.agentForRoute(route.id);
            if (!agent)
                return { ok: false, error: 'agent CLI disappeared between detection and run' };
            // Headless CLIs take one combined prompt, so the system prompt is prepended.
            return (0, headless_runner_1.runHeadless)(agent, `${system}\n\n---\n\n${prompt}`, signal);
        }
        return AiProviderService_1.aiProviderService.complete(system, prompt, signal);
    }
    /**
     * Turn the model's JSON into a validated guide.
     *
     * The model authors prose — titles, bodies, why, verify. Everything mechanical
     * (selectors, screenshots, urlPattern, outputs) is taken from the session, not from the
     * model, so a hallucinated selector cannot reach a guide and a declared harvest target
     * cannot be invented.
     */
    assemble(raw, session, steps, options, transport, customize, replacementId) {
        const extracted = extractJson(raw);
        if (!extracted)
            return { ok: false, error: 'the model did not return JSON' };
        let authored;
        try {
            authored = JSON.parse(extracted);
        }
        catch (err) {
            return { ok: false, error: `the model returned malformed JSON: ${err.message}` };
        }
        const authoredById = new Map();
        for (const step of authored.steps ?? []) {
            if (step && typeof step.id === 'string')
                authoredById.set(step.id, step);
        }
        const manifest = RedactionService_1.redactionService.manifestFor(session.id);
        const candidate = {
            schemaVersion: schema_1.SCHEMA_VERSION,
            id: replacementId ?? (slugify(options.title) || (0, crypto_1.randomUUID)()),
            mode: 'standalone',
            title: options.title || authored.title || session.title || 'Untitled guide',
            intent: str(authored.intent),
            audience: options.audience || str(authored.audience),
            language: customize.languages.codes[0] ?? 'en',
            video: customize.video.enabled ? customize.video : undefined,
            branding: customize.branding.enabled ? customize.branding : undefined,
            estimatedMinutes: typeof authored.estimatedMinutes === 'number' ? Math.max(0, Math.round(authored.estimatedMinutes)) : undefined,
            prerequisites: Array.isArray(authored.prerequisites) ? authored.prerequisites.filter(isNonEmptyString) : [],
            domains: domainsOf(steps),
            generatedAt: new Date().toISOString(),
            transport,
            redaction: {
                acknowledgedAt: session.redactionAckAt ?? new Date().toISOString(),
                rules: manifest.rules,
                placeholders: manifest.placeholders,
            },
            steps: steps.map((step, index) => {
                const authoredStep = authoredById.get(step.id);
                const title = str(authoredStep?.title) || fallbackTitle(step);
                /**
                 * Chapter and branches are taken from the *session*, exactly like selectors and
                 * outputs — the model authors prose and nothing structural. A hallucinated branch
                 * would send a reader to the wrong step with full confidence.
                 */
                const chapter = step.chapter?.trim() || undefined;
                const branches = step.branches?.length ? step.branches : undefined;
                return {
                    id: step.id,
                    title,
                    body: str(authoredStep?.body),
                    why: str(authoredStep?.why) || undefined,
                    // Mechanical fields come from the recording, never from the model.
                    urlPattern: step.urlPattern,
                    selectors: step.selectors.map((s) => s.value),
                    a11y: step.a11y,
                    screenshot: step.screenshot,
                    // Placement comes from the rect the recorder measured, not from the model — a
                    // hallucinated arrow position would point confidently at the wrong control.
                    // Review-editor marks are already in this rendered PNG; do not duplicate the arrow.
                    annotations: step.screenshot && !step.annotationProject ? (0, annotations_1.deriveAnnotations)(step.targetRect, index, customize.annotations, title) : [],
                    verify: normalizeVerify(authoredStep?.verify),
                    outputs: step.outputs.length ? step.outputs : undefined,
                    chapter,
                    branches,
                    altSelectors: step.altSelectors?.length ? step.altSelectors : undefined,
                    redacted: step.valueMasked || step.warnings.length > 0,
                };
            }),
            assessments: (() => {
                const raw = GuideSessionStore_1.guideSessionStore.assessments(session.id);
                return Array.isArray(raw) && raw.length ? raw : undefined;
            })(),
        };
        const parsed = schema_1.GuideSchema.safeParse(candidate);
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            return { ok: false, error: `assembled guide is invalid at ${issue?.path.join('.')}: ${issue?.message}` };
        }
        // Round-trip through the loader so a guide we wrote can always be read back.
        const verified = (0, schema_1.parseGuide)(JSON.parse(JSON.stringify(parsed.data)));
        if (!verified.ok)
            return { ok: false, error: verified.error };
        return { ok: true, guide: verified.guide };
    }
}
exports.GeneratorService = GeneratorService;
function buildPrompt(session, steps, options, customize) {
    const machine = session.source === 'machine';
    /**
     * Two trace shapes, because they describe two different things. A browser step is a DOM
     * event with selectors; a machine step is a screenshot of a window with a human's note on
     * it. Handing the machine steps to the browser shape would emit empty `selectors` arrays
     * and an `app://` urlPattern, which reads to a model as web structure it should describe.
     */
    const trace = steps.map((step) => machine
        ? {
            id: step.id,
            window: step.windowTitle || step.pageTitle,
            note: step.note || undefined,
            hasScreenshot: !!step.screenshot,
        }
        : {
            id: step.id,
            kind: step.kind,
            urlPattern: step.urlPattern,
            pageTitle: step.pageTitle,
            selectors: step.selectors.map((s) => `${s.strategy}=${s.value}`),
            a11y: step.a11y,
            // Placeholders survive; real values were destroyed or masked before this point.
            typedValue: step.valueMasked ? step.placeholder : step.value,
            hasScreenshot: !!step.screenshot,
        });
    const primary = customize.languages.codes[0] ?? 'en';
    return [
        `# What the Maker says about this flow`,
        options.prompt.trim() || '(no notes provided)',
        '',
        `Audience: ${options.audience || 'unspecified'}`,
        `Working title: ${options.title || session.title || '(none)'}`,
        ...(machine ? [`Application window recorded: ${session.targetWindow || '(unnamed)'}`] : []),
        `Write every string in ${(0, customize_1.languageName)(primary)} (${primary}).`,
        (0, customize_1.docTypePrompt)(customize.docType),
        ...(customize.video.enabled
            ? [
                'This guide will also be narrated as a video, one screenshot per step, so keep each',
                `"title" short enough to read on a frame in ${customize.video.secondsPerStep} seconds.`,
            ]
            : []),
        '',
        machine ? `# Captured window sequence (${trace.length} steps)` : `# Redacted event trace (${trace.length} steps)`,
        JSON.stringify(trace, null, 2),
        '',
        `# Required output shape`,
        JSON.stringify({
            title: 'string',
            intent: 'string',
            audience: 'string',
            estimatedMinutes: 0,
            prerequisites: ['string'],
            steps: [
                {
                    id: 'the id from the trace',
                    title: 'string',
                    body: 'string',
                    why: 'string',
                    verify: machine ? { kind: 'manual', value: 'string' } : { kind: 'urlMatches', value: 'string' },
                },
            ],
        }, null, 2),
        '',
        machine
            ? `The only valid "verify" kind here is manual. Omit "verify" when you have nothing concrete.`
            : `Valid "verify" kinds: urlMatches, selectorPresent, selectorAbsent, textPresent, manual.`,
        `Return the JSON object only.`,
    ].join('\n');
}
/** Models wrap JSON in prose or fences no matter how firmly you ask them not to. */
function extractJson(raw) {
    const text = raw.trim();
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    const body = fenced ? fenced[1].trim() : text;
    const start = body.indexOf('{');
    if (start === -1)
        return null;
    // Walk to the matching brace so trailing commentary does not break the parse.
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < body.length; i += 1) {
        const ch = body[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            continue;
        }
        if (ch === '"')
            inString = !inString;
        if (inString)
            continue;
        if (ch === '{')
            depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0)
                return body.slice(start, i + 1);
        }
    }
    return null;
}
const VERIFY_KINDS = new Set(['urlMatches', 'selectorPresent', 'selectorAbsent', 'textPresent', 'manual']);
function normalizeVerify(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const candidate = value;
    if (typeof candidate.kind !== 'string' || !VERIFY_KINDS.has(candidate.kind))
        return undefined;
    const raw = typeof candidate.value === 'string' ? candidate.value : '';
    if (candidate.kind === 'manual')
        return { kind: 'manual', value: raw };
    if (!raw)
        return undefined;
    return { kind: candidate.kind, value: raw };
}
function domainsOf(steps) {
    const hosts = new Set();
    for (const step of steps) {
        try {
            if (step.url)
                hosts.add(new URL(step.url).hostname);
        }
        catch {
            // A step without a parseable URL simply contributes no domain.
        }
    }
    return Array.from(hosts).sort();
}
function fallbackTitle(step) {
    if (step.a11y.name)
        return `${capitalize(step.kind)} "${step.a11y.name}"`;
    return `${capitalize(step.kind)} step`;
}
function capitalize(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
}
function str(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
function providerLabel(id) {
    switch (id) {
        case 'anthropic':
            return 'Anthropic';
        case 'openai':
            return 'OpenAI';
        case 'gemini':
            return 'Gemini';
        case 'azure':
            return 'Azure OpenAI';
        case 'openai-compatible':
            return 'OpenAI-compatible';
        default:
            return id;
    }
}
function slugify(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}
exports.generatorService = new GeneratorService();
//# sourceMappingURL=GeneratorService.js.map