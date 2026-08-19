"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.askPrompt = askPrompt;
/**
 * Grounded Q&A over a guide. The answer is generated from the guide's own prose and
 * reasoning — never screenshots by default. If the guide does not know, we say so.
 *
 * Lives in the overlay and the app only. Never in the HTML export.
 */
function askPrompt(guide, question) {
    const chapters = guide.steps
        .map((step, i) => {
        const bits = [`${i + 1}. ${step.title}`];
        if (step.body)
            bits.push(step.body);
        if (step.why)
            bits.push(`Why: ${step.why}`);
        return bits.join('\n');
    })
        .join('\n\n');
    return {
        system: [
            'You answer questions about one walkthrough guide.',
            'Use only the guide text below. If the guide does not say, say you do not know — do not invent a control, a URL, or a value.',
            'Never ask for or repeat secrets. Never include screenshots or selectors.',
            'Answer in the same language as the question, briefly.',
            '',
            `Title: ${guide.title}`,
            guide.intent ? `Intent: ${guide.intent}` : '',
            '',
            chapters,
        ]
            .filter(Boolean)
            .join('\n'),
        user: question.trim().slice(0, 500),
    };
}
//# sourceMappingURL=askGuide.js.map