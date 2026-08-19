"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StoredAnnotationProjectSchema = exports.AnnotationEditorProjectSchema = exports.AnnotationEditorElementSchema = void 0;
exports.parseAnnotationProject = parseAnnotationProject;
exports.parseStoredAnnotationProject = parseStoredAnnotationProject;
const zod_1 = require("zod");
const DataImageSchema = zod_1.z
    .string()
    .max(16 * 1024 * 1024)
    .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i, 'inserted image must be PNG, JPEG, or WebP');
const PointSchema = zod_1.z.object({
    x: zod_1.z.number().min(-2).max(3),
    y: zod_1.z.number().min(-2).max(3),
});
exports.AnnotationEditorElementSchema = zod_1.z.strictObject({
    id: zod_1.z.string().min(1).max(80),
    kind: zod_1.z.enum([
        'rectangle',
        'ellipse',
        'line',
        'arrow',
        'text',
        'pixelate',
        'spotlight',
        'counter',
        'pencil',
        'highlighter',
        'image',
    ]),
    x: zod_1.z.number().min(-2).max(3),
    y: zod_1.z.number().min(-2).max(3),
    w: zod_1.z.number().min(-3).max(3),
    h: zod_1.z.number().min(-3).max(3),
    color: zod_1.z.string().regex(/^#[0-9a-f]{6}$/i),
    strokeWidth: zod_1.z.number().min(1).max(80),
    filled: zod_1.z.boolean().optional(),
    arrowStyle: zod_1.z.enum(['straight', 'elbow', 'curved', 'double']).optional(),
    arrowHead: zod_1.z.enum(['filled', 'open', 'dot', 'none']).optional(),
    text: zod_1.z.string().max(500).optional(),
    textStyle: zod_1.z.enum(['title', 'caption', 'label', 'badge', 'outline', 'mono', 'note']).optional(),
    fontSize: zod_1.z.number().min(8).max(256).optional(),
    points: zod_1.z.array(PointSchema).max(12_000).optional(),
    src: DataImageSchema.optional(),
    opacity: zod_1.z.number().min(0.05).max(1).optional(),
});
exports.AnnotationEditorProjectSchema = zod_1.z.strictObject({
    version: zod_1.z.literal(1),
    crop: zod_1.z.strictObject({
        x: zod_1.z.number().min(0).max(1),
        y: zod_1.z.number().min(0).max(1),
        w: zod_1.z.number().min(0.005).max(1),
        h: zod_1.z.number().min(0.005).max(1),
    }),
    elements: zod_1.z.array(exports.AnnotationEditorElementSchema).max(128),
    background: zod_1.z.strictObject({
        mode: zod_1.z.enum(['none', 'gradient', 'wallpaper', 'blurred', 'plain']),
        value: zod_1.z.string().max(500),
        customWallpaper: DataImageSchema.optional(),
        padding: zod_1.z.number().min(0).max(500),
        inset: zod_1.z.number().min(0).max(90),
        autoBalance: zod_1.z.boolean(),
        shadow: zod_1.z.number().min(0).max(100),
        corners: zod_1.z.number().min(0).max(200),
        alignX: zod_1.z.union([zod_1.z.literal(0), zod_1.z.literal(1), zod_1.z.literal(2)]),
        alignY: zod_1.z.union([zod_1.z.literal(0), zod_1.z.literal(1), zod_1.z.literal(2)]),
        ratio: zod_1.z.enum(['auto', '1:1', '4:3', '16:9', '4:5', '9:16']),
    }),
    nextCounter: zod_1.z.number().int().min(1).max(10_000),
    presetName: zod_1.z.string().max(80),
});
exports.StoredAnnotationProjectSchema = zod_1.z.strictObject({
    sourceScreenshot: zod_1.z.string().min(1).max(500),
    project: exports.AnnotationEditorProjectSchema,
});
function parseAnnotationProject(value) {
    let bytes = 0;
    try {
        bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    }
    catch {
        throw new Error('annotation project must be serializable');
    }
    if (bytes > 48 * 1024 * 1024)
        throw new Error('annotation project is too large');
    const parsed = exports.AnnotationEditorProjectSchema.safeParse(value);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`invalid annotation project at ${issue?.path.join('.') || 'root'}: ${issue?.message || 'unknown error'}`);
    }
    return parsed.data;
}
function parseStoredAnnotationProject(value) {
    const parsed = exports.StoredAnnotationProjectSchema.safeParse(value);
    if (!parsed.success)
        throw new Error('the saved annotation project is damaged or from a newer version');
    return parsed.data;
}
//# sourceMappingURL=AnnotationProject.js.map