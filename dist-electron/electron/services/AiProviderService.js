"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiProviderService = exports.AiProviderService = void 0;
const CredentialVault_1 = require("./CredentialVault");
const db_1 = require("../db");
/**
 * Only Anthropic gets a default model, because it is the one this build can name with
 * confidence. For every other provider the user picks the model in settings — inventing
 * a plausible-looking model id produces a 404 at generation time and a confusing bug
 * report.
 */
const DEFAULT_MODELS = {
    anthropic: 'claude-opus-5',
};
const VAULT_KEY_PREFIX = 'byok.';
const SETTINGS_KEY = 'byok.provider';
const MAX_OUTPUT_TOKENS = 16000;
const PROVIDER_IDS = ['anthropic', 'openai', 'gemini', 'azure', 'openai-compatible'];
class AiProviderService {
    // ---------------------------------------------------------------- config
    getConfig() {
        const row = (0, db_1.getDb)().prepare(`SELECT value FROM settings WHERE key = ?`).get(SETTINGS_KEY);
        if (!row)
            return null;
        try {
            const parsed = JSON.parse(row.value);
            // A stored id outside the union would fall off the end of complete()'s switch and
            // return undefined — a TypeError three calls later instead of a sentence here.
            return PROVIDER_IDS.includes(parsed?.id) ? parsed : null;
        }
        catch {
            return null;
        }
    }
    setConfig(config) {
        if (!PROVIDER_IDS.includes(config?.id))
            throw new Error(`unknown provider: ${String(config?.id)}`);
        const model = config.model.trim() || DEFAULT_MODELS[config.id] || '';
        if (!model)
            throw new Error(`a model id is required for ${config.id}`);
        if ((config.id === 'openai-compatible' || config.id === 'azure') && !config.baseUrl) {
            throw new Error(`${config.id} requires a base URL`);
        }
        (0, db_1.getDb)()
            .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
            .run(SETTINGS_KEY, JSON.stringify({ ...config, model }));
    }
    async setApiKey(provider, key) {
        if (!key.trim())
            throw new Error('api key required');
        await CredentialVault_1.credentialVault.set(`${VAULT_KEY_PREFIX}${provider}`, key.trim());
    }
    async hasApiKey(provider) {
        return CredentialVault_1.credentialVault.has(`${VAULT_KEY_PREFIX}${provider}`);
    }
    async clearApiKey(provider) {
        await CredentialVault_1.credentialVault.delete(`${VAULT_KEY_PREFIX}${provider}`);
    }
    /** Configured and holding a key — the check the generator makes before offering BYOK. */
    async isReady() {
        const config = this.getConfig();
        if (!config)
            return false;
        return this.hasApiKey(config.id);
    }
    // ---------------------------------------------------------------- completion
    async complete(system, prompt, signal) {
        const config = this.getConfig();
        if (!config)
            return { ok: false, error: 'no BYOK provider configured' };
        const apiKey = await CredentialVault_1.credentialVault.get(`${VAULT_KEY_PREFIX}${config.id}`);
        if (!apiKey)
            return { ok: false, error: `no API key stored for ${config.id}` };
        try {
            switch (config.id) {
                case 'anthropic':
                    return await this.anthropic(config, apiKey, system, prompt, signal);
                case 'gemini':
                    return await this.gemini(config, apiKey, system, prompt, signal);
                case 'openai':
                case 'azure':
                case 'openai-compatible':
                    return await this.openAiCompatible(config, apiKey, system, prompt, signal);
            }
        }
        catch (err) {
            return { ok: false, error: err.message };
        }
    }
    async anthropic(config, apiKey, system, prompt, signal) {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            signal,
            headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            /**
             * No temperature / top_p / top_k: they are rejected outright on current Opus and
             * Sonnet models, and there is nothing here worth sampling-tuning anyway.
             */
            body: JSON.stringify({
                model: config.model,
                max_tokens: MAX_OUTPUT_TOKENS,
                system,
                messages: [{ role: 'user', content: prompt }],
            }),
        });
        if (!res.ok)
            return { ok: false, error: await describeHttpError(res) };
        const data = (await res.json());
        // Check stop_reason before touching content — on a refusal the array can be empty.
        if (data.stop_reason === 'refusal') {
            const category = data.stop_details?.category;
            return { ok: false, error: `the model declined this request${category ? ` (${category})` : ''}` };
        }
        const text = (data.content ?? [])
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('');
        return text ? { ok: true, text } : { ok: false, error: 'model returned no text' };
    }
    async openAiCompatible(config, apiKey, system, prompt, signal) {
        const url = config.id === 'azure'
            ? `${trimSlash(config.baseUrl)}/openai/deployments/${config.model}/chat/completions?api-version=${config.apiVersion ?? '2024-10-21'}`
            : `${trimSlash(config.baseUrl ?? 'https://api.openai.com')}/v1/chat/completions`;
        const headers = { 'content-type': 'application/json' };
        if (config.id === 'azure')
            headers['api-key'] = apiKey;
        else
            headers.authorization = `Bearer ${apiKey}`;
        const res = await fetch(url, {
            method: 'POST',
            signal,
            headers,
            body: JSON.stringify({
                model: config.model,
                max_completion_tokens: MAX_OUTPUT_TOKENS,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: prompt },
                ],
            }),
        });
        if (!res.ok)
            return { ok: false, error: await describeHttpError(res) };
        const data = (await res.json());
        const text = data.choices?.[0]?.message?.content ?? '';
        return text ? { ok: true, text } : { ok: false, error: 'model returned no text' };
    }
    async gemini(config, apiKey, system, prompt, signal) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
        const res = await fetch(url, {
            method: 'POST',
            signal,
            headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: system }] },
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
            }),
        });
        if (!res.ok)
            return { ok: false, error: await describeHttpError(res) };
        const data = (await res.json());
        const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
        return text ? { ok: true, text } : { ok: false, error: 'model returned no text' };
    }
}
exports.AiProviderService = AiProviderService;
function trimSlash(url) {
    return url.replace(/\/+$/, '');
}
/** Surface the provider's own message — "400 Bad Request" alone is never actionable. */
async function describeHttpError(res) {
    let detail = '';
    try {
        const body = await res.text();
        const parsed = JSON.parse(body);
        detail = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? body.slice(0, 300));
    }
    catch {
        detail = '';
    }
    return `provider returned ${res.status}${detail ? `: ${detail}` : ''}`;
}
exports.aiProviderService = new AiProviderService();
//# sourceMappingURL=AiProviderService.js.map