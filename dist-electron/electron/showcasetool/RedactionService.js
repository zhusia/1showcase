"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redactionService = exports.RedactionService = void 0;
exports.rebaseTargetRect = rebaseTargetRect;
const crypto_1 = require("crypto");
const db_1 = require("../db");
const GuideSessionStore_1 = require("./GuideSessionStore");
const ScreenshotStore_1 = require("./ScreenshotStore");
const redactionPatterns_1 = require("./redactionPatterns");
class RedactionService {
    // ---------------------------------------------------------------- rules
    listRules(scope) {
        const rows = scope
            ? (0, db_1.getDb)().prepare(`SELECT * FROM redaction_rules WHERE scope = ? ORDER BY created_at`).all(scope)
            : (0, db_1.getDb)().prepare(`SELECT * FROM redaction_rules ORDER BY created_at`).all();
        return rows;
    }
    addRule(rule) {
        if (rule.kind === 'regex') {
            try {
                new RegExp(rule.pattern);
            }
            catch (err) {
                throw new Error(`invalid regex: ${err.message}`);
            }
        }
        const id = (0, crypto_1.randomUUID)();
        (0, db_1.getDb)()
            .prepare(`INSERT INTO redaction_rules (id, scope, kind, pattern, placeholder) VALUES (?, ?, ?, ?, ?)`)
            .run(id, rule.scope, rule.kind, rule.pattern, rule.placeholder);
        return { id, ...rule };
    }
    deleteRule(id) {
        (0, db_1.getDb)().prepare(`DELETE FROM redaction_rules WHERE id = ?`).run(id);
    }
    /**
     * Apply every saved project rule to a session's stored values. Custom rules are the
     * mechanism that stops a Maker re-painting the same internal hostname on every
     * recording (§7.2 Layer 2).
     */
    applyProjectRules(sessionId) {
        const rules = this.listRules('project');
        if (!rules.length)
            return 0;
        let changed = 0;
        // Which rules touched *this* session. The manifest cannot work this out later: a fired rule
        // has replaced its own pattern with the placeholder, so there is nothing left to match on.
        const fired = new Map();
        for (const step of GuideSessionStore_1.guideSessionStore.steps(sessionId)) {
            if (!step.value)
                continue;
            let next = step.value;
            for (const rule of rules) {
                const before = next;
                if (rule.kind === 'literal') {
                    if (next.includes(rule.pattern))
                        next = next.split(rule.pattern).join(rule.placeholder);
                }
                else {
                    try {
                        next = next.replace(new RegExp(rule.pattern, 'g'), rule.placeholder);
                    }
                    catch {
                        // A rule that no longer compiles is skipped rather than failing the pass.
                    }
                }
                if (next !== before)
                    fired.set(rule.id, rule);
            }
            if (next !== step.value) {
                GuideSessionStore_1.guideSessionStore.setStepValue(step.id, next, true, step.placeholder ?? null);
                changed += 1;
            }
        }
        if (fired.size)
            this.recordRuleHits(sessionId, Array.from(fired.values()));
        if (changed)
            GuideSessionStore_1.guideSessionStore.invalidateAcknowledgement(sessionId);
        return changed;
    }
    /**
     * Accumulative, never a replace: this pass runs on every review open, and by the second one the
     * patterns are already gone, so a rule that fired the first time would otherwise drop out of its
     * own session's manifest.
     */
    recordRuleHits(sessionId, rules) {
        const insert = (0, db_1.getDb)().prepare(`INSERT OR IGNORE INTO redaction_rule_hits (session_id, rule_id, placeholder) VALUES (?, ?, ?)`);
        for (const rule of rules)
            insert.run(sessionId, rule.id, rule.placeholder);
    }
    // ---------------------------------------------------------------- masking
    /**
     * Mask one captured value everywhere it appears in the session and give it a named
     * placeholder. Session-wide by design: a Maker who masks a client id on step 3 has
     * masked it on step 11 too, without having to notice step 11 exists.
     *
     * The placeholder is the point — "paste <YOUR_CLIENT_ID>" is a more reusable guide
     * than one containing one person's real value.
     */
    maskValue(sessionId, rawValue, placeholder) {
        const value = rawValue.trim();
        if (value.length < 3)
            throw new Error('value too short to mask safely');
        const named = placeholder.trim() || '<REDACTED>';
        let valuesMasked = 0;
        const screenshotsToReview = [];
        for (const step of GuideSessionStore_1.guideSessionStore.steps(sessionId)) {
            const touched = !!step.value && step.value.includes(value);
            if (touched && step.value) {
                GuideSessionStore_1.guideSessionStore.setStepValue(step.id, step.value.split(value).join(named), true, named);
                valuesMasked += 1;
            }
            // Text match on a step is the strongest signal its screenshot shows the value.
            if ((touched || step.pageTitle.includes(value)) && step.screenshot) {
                screenshotsToReview.push({ stepId: step.id, screenshot: step.screenshot });
            }
        }
        // Remember it as a session rule so a later re-record of the same flow catches it.
        this.addRule({ scope: 'session', kind: 'literal', pattern: value, placeholder: named });
        GuideSessionStore_1.guideSessionStore.invalidateAcknowledgement(sessionId);
        return { valuesMasked, screenshotsToReview };
    }
    /**
     * Overwrite a stored screenshot with the canvas output from the review editor.
     * The renderer paints solid fills — never blur (§7.2: blur is a visual effect, not a
     * destruction primitive) — and sends back re-encoded PNG bytes.
     */
    paintScreenshot(sessionId, stepId, dataUri) {
        const step = GuideSessionStore_1.guideSessionStore.step(stepId);
        if (!step || step.sessionId !== sessionId)
            throw new Error('step does not belong to session');
        if (!step.screenshot)
            throw new Error('step has no screenshot');
        const ok = ScreenshotStore_1.screenshotStore.overwrite(step.screenshot, dataUri);
        if (ok) {
            GuideSessionStore_1.guideSessionStore.flattenAnnotationProject(stepId);
            GuideSessionStore_1.guideSessionStore.recordPixelEdit(stepId, 'paint');
            GuideSessionStore_1.guideSessionStore.invalidateAcknowledgement(sessionId);
        }
        return ok;
    }
    /**
     * Crop a stored screenshot (docs/competitor-features.md §2.7).
     *
     * Reuses the destructive-overwrite primitive redaction already owns — cropping is the same
     * act as painting, in that the pixels outside the box are gone and there is no undo.
     *
     * It gets its own method rather than going through paintScreenshot because of `target_rect`.
     * That rect is where the recorder measured the interacted element, stored as 0..1 fractions
     * **of this screenshot**. Change the frame and every one of those fractions now points
     * somewhere else, so an annotation that was on the button lands in the middle of nothing.
     * Painting cannot cause that; cropping always does. Routing crop through the paint path would
     * leave the coordinates silently stale, which is exactly the class of bug that is invisible
     * until an export looks wrong.
     */
    cropScreenshot(sessionId, stepId, dataUri, crop) {
        const step = GuideSessionStore_1.guideSessionStore.step(stepId);
        if (!step || step.sessionId !== sessionId)
            throw new Error('step does not belong to session');
        if (!step.screenshot)
            throw new Error('step has no screenshot');
        const ok = ScreenshotStore_1.screenshotStore.overwrite(step.screenshot, dataUri);
        if (!ok)
            return false;
        GuideSessionStore_1.guideSessionStore.flattenAnnotationProject(stepId);
        GuideSessionStore_1.guideSessionStore.recordPixelEdit(stepId, 'crop');
        GuideSessionStore_1.guideSessionStore.setTargetRect(stepId, rebaseTargetRect(step.targetRect, crop));
        GuideSessionStore_1.guideSessionStore.invalidateAcknowledgement(sessionId);
        return true;
    }
    // ---------------------------------------------------------------- warnings
    /**
     * Re-derive Layer 1's warnings against current stored content. Runs when the review
     * screen opens so the Maker sees what is still outstanding rather than what was true
     * at capture time.
     *
     * One transaction, and only changed rows are written. The review screen re-runs this after
     * every edit, and it used to be an autocommit write (an fsync) per step whether or not
     * anything changed — a 60-step session paid 60 transactions per keystroke-level action.
     */
    recomputeWarnings(sessionId) {
        let total = 0;
        const writes = [];
        for (const step of GuideSessionStore_1.guideSessionStore.steps(sessionId)) {
            if (step.dropped)
                continue;
            const warnings = [];
            if (step.value) {
                for (const hit of (0, redactionPatterns_1.detectSecrets)(step.value)) {
                    warnings.push({ rule: hit.rule, label: hit.label, where: 'value', sample: sample(hit.text) });
                }
                if (!step.valueMasked && (0, redactionPatterns_1.looksHighEntropy)(step.value)) {
                    warnings.push({
                        rule: 'auto:high-entropy',
                        label: 'High-entropy string — may be a secret',
                        where: 'value',
                        sample: sample(step.value),
                    });
                }
            }
            const fieldName = step.a11y.name ?? '';
            if (fieldName && (0, redactionPatterns_1.isSensitiveFieldName)(fieldName) && step.value && !step.valueMasked) {
                warnings.push({
                    rule: 'auto:sensitive-field-name',
                    label: `Field named "${fieldName}" holds an unmasked value`,
                    where: 'field-name',
                    sample: sample(step.value),
                });
            }
            total += warnings.length;
            if (JSON.stringify(warnings) !== JSON.stringify(step.warnings))
                writes.push({ stepId: step.id, warnings });
        }
        if (writes.length) {
            (0, db_1.getDb)().transaction(() => {
                for (const write of writes)
                    GuideSessionStore_1.guideSessionStore.setStepWarnings(write.stepId, write.warnings);
            })();
        }
        return total;
    }
    /** Every rule id that actually fired for this session — the published manifest (§7.4). */
    manifestFor(sessionId) {
        const rules = new Set();
        const placeholders = new Set();
        for (const step of GuideSessionStore_1.guideSessionStore.steps(sessionId, false)) {
            for (const warning of step.warnings)
                rules.add(warning.rule);
            if (step.valueMasked)
                rules.add('manual:value-mask');
            if (step.placeholder)
                placeholders.add(step.placeholder);
        }
        /*
          Only the project rules that fired on this session. Reading the whole rule table here meant a
          mask performed on an unrelated recording put its placeholder — and every project rule's
          pattern — into *this* guide's published manifest, for a redaction that never happened to it.
    
          Session rules are deliberately not consulted at all: `maskValue` writes `valueMasked` and the
          placeholder onto the steps it touched, so the loop above already reports it, per session and
          without the cross-contamination.
        */
        const hits = (0, db_1.getDb)()
            .prepare(`SELECT placeholder FROM redaction_rule_hits WHERE session_id = ?`)
            .all(sessionId);
        /*
          Labelled by placeholder, never by pattern. This manifest ships inside the guide, and the
          pattern *is* the thing the rule was written to destroy — publishing "custom:acme-internal.
          example.com" hands the reader the hostname the Maker redacted, which is the redaction undone
          by its own audit trail. The placeholder discloses nothing new: the Maker chose it to be read,
          it is already in the guide's prose where the value used to be, and it is already published in
          `placeholders` below. Two rules sharing the default `<REDACTED>` collapse to one entry — the
          manifest says what a reader can verify, and it cannot verify a distinction it cannot see.
        */
        for (const hit of hits) {
            rules.add(hit.placeholder ? `custom:${hit.placeholder.slice(0, 24)}` : 'custom:rule');
            if (hit.placeholder)
                placeholders.add(hit.placeholder);
        }
        /*
          Painting and cropping, the two destructive edits that leave no other trace — they overwrite
          the stored PNG in place, so the frame afterwards looks like one that never needed redacting.
          Reported per session and only for steps that ship, matching the loop above.
    
          This matters most where the manifest was previously emptiest. A machine recording has no
          Layer 1 and no captured values, so painting is the *only* redaction that happens to it, and
          until now its guide published a manifest saying nothing had been done at all.
        */
        const edited = (0, db_1.getDb)()
            .prepare(`SELECT pixel_edits FROM session_steps WHERE session_id = ? AND dropped = 0`)
            .all(sessionId);
        for (const row of edited) {
            let applied;
            try {
                applied = JSON.parse(row.pixel_edits);
            }
            catch {
                continue;
            }
            if (!Array.isArray(applied))
                continue;
            if (applied.includes('paint'))
                rules.add('manual:pixel-paint');
            if (applied.includes('crop'))
                rules.add('manual:pixel-crop');
        }
        return { rules: Array.from(rules).sort(), placeholders: Array.from(placeholders).sort() };
    }
    /**
     * The gate itself. Everything downstream — generate, export, publish — calls this
     * first and refuses when it throws.
     */
    assertAcknowledged(sessionId) {
        if (!GuideSessionStore_1.guideSessionStore.isRedactionAcknowledged(sessionId)) {
            throw new Error('Redaction review has not been acknowledged for this session. Complete the review pass first.');
        }
    }
}
exports.RedactionService = RedactionService;
function sample(text) {
    const trimmed = text.trim();
    if (trimmed.length <= 8)
        return '•'.repeat(trimmed.length);
    return `${trimmed.slice(0, 4)}${'•'.repeat(Math.min(8, trimmed.length - 8))}${trimmed.slice(-4)}`;
}
exports.redactionService = new RedactionService();
/**
 * Re-express a target rect against a cropped frame.
 *
 * Both rects are 0..1 fractions of the *original* image. After the crop, the new origin is the
 * crop's own origin and the new unit is the crop's own size, so each coordinate is shifted then
 * rescaled. A target that fell outside the kept region has no meaningful position any more and
 * becomes undefined — which is exactly what a step with no measured target already means
 * elsewhere in the pipeline, so the annotation degrades to a corner badge rather than pointing
 * confidently at the wrong control.
 */
function rebaseTargetRect(target, crop) {
    if (!target)
        return undefined;
    if (!(crop.width > 0) || !(crop.height > 0))
        return target;
    // Any overlap at all is kept; a target only half inside is still worth pointing at.
    const left = Math.max(target.x, crop.x);
    const top = Math.max(target.y, crop.y);
    const right = Math.min(target.x + target.width, crop.x + crop.width);
    const bottom = Math.min(target.y + target.height, crop.y + crop.height);
    if (!(right > left) || !(bottom > top))
        return undefined;
    return {
        x: (left - crop.x) / crop.width,
        y: (top - crop.y) / crop.height,
        width: (right - left) / crop.width,
        height: (bottom - top) / crop.height,
    };
}
//# sourceMappingURL=RedactionService.js.map