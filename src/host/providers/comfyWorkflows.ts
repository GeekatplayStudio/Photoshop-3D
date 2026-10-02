/**
 * ComfyUI workflows for image → 3D, as pure functions (no I/O) so they are unit-tested.
 *
 * Built-in: TRELLIS.2 (native nodes, ComfyUI ≥ 0.34). The graph is the Comfy-Org template
 * "3d_pixal3d_trellis2_image_to_model" reduced to its TRELLIS.2 branch, with the template's
 * Save3DAdvanced (whose required viewport_state comes from the frontend's 3D viewer) replaced
 * by core SaveGLB. Node names and inputs were checked against ComfyUI 0.38's /object_info and
 * the template on 2026-10-02. Verified on ComfyUI 0.38 / RTX 3090: ~4.5 min, ~30 MB textured GLB.
 *
 * Custom: any API-format workflow (ComfyUI → Workflow → Export (API)) with a LoadImage node
 * and a node that saves a .glb/.gltf (SaveGLB, Save3DAdvanced, or a custom node).
 */

export type ApiNode = { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } };
export type ApiWorkflow = Record<string, ApiNode>;

export const TRELLIS2_REQUIRED_NODES = [
    "Trellis2Conditioning",
    "Trellis2ShapeStage",
    "Trellis2UpsampleStage",
    "Trellis2TextureStage",
    "VaeDecodeShapeTrellis",
    "VaeDecodeTextureTrellis",
    "BakeTextureFromVoxel",
    "SaveGLB",
] as const;

export const TRELLIS2_MODEL_FILES = {
    unet: "trellis_2_int8_convrot.safetensors",
    shapeVae: "trellis_2_shape_vae_bf16.safetensors",
    textureVae: "trellis_2_texture_vae_bf16.safetensors",
    clipVision: "dino_v3_L_naf_fp32.safetensors",
    backgroundRemoval: "birefnet.safetensors",
} as const;

/** Accepted substitutes when the template's file is not installed (docs.comfy.org TRELLIS.2 tutorial). */
export const TRELLIS2_MODEL_ALTERNATIVES: Partial<Record<keyof typeof TRELLIS2_MODEL_FILES, RegExp>> = {
    unet: /^trellis_2(?!.*vae).*\.safetensors$/i,
    clipVision: /^dino_v3.*\.safetensors$/i,
    backgroundRemoval: /\.safetensors$/i,
};

export type Trellis2Files = { -readonly [K in keyof typeof TRELLIS2_MODEL_FILES]: string };

/**
 * Picks the installed file for a model slot from a loader's options: the expected name (also
 * inside a subfolder, e.g. "trellis/trellis_2_int8_convrot.safetensors"), else an accepted
 * alternative. Undefined when neither is installed.
 */
export function pickModelFile(options: readonly string[], preferred: string, alternative?: RegExp): string | undefined {
    const base = (o: string) => o.split(/[\\/]/).pop() ?? o;
    return options.find((o) => o === preferred) ?? options.find((o) => base(o) === preferred) ?? (alternative ? options.find((o) => alternative.test(base(o))) : undefined);
}

export const TRELLIS2_IMAGE_NODE = "122";
const SAVE_NODE = "900";

export type Trellis2Options = {
    /** ComfyUI input image name, e.g. "photoshop3d/layer.png". */
    image: string;
    /** Use the layer's transparency as the object mask instead of BiRefNet. */
    useAlphaMask: boolean;
    textureSize: number;
    faceCount: number;
    seed: number;
    filenamePrefix?: string;
    /** Installed model files (see pickModelFile); defaults to the template's names. */
    files?: Partial<Trellis2Files>;
};

export function buildTrellis2Workflow(o: Trellis2Options): ApiWorkflow {
    const f: Trellis2Files = { ...TRELLIS2_MODEL_FILES, ...o.files };
    const seed = (offset: number) => (o.seed + offset) % 2 ** 48;
    const wf: ApiWorkflow = {
        "122": { class_type: "LoadImage", _meta: { title: "Photoshop Image" }, inputs: { image: o.image } },
        "15": { class_type: "CLIPVisionLoader", inputs: { clip_name: f.clipVision } },
        "312": {
            class_type: "ImageCropToMask",
            inputs: { images: ["122", 0], masks: o.useAlphaMask ? ["195", 0] : ["192", 0], width: 1024, height: 1024, pad_factor: 1.1, grow_mask: 0, background: "#000000" },
        },
        "299": { class_type: "Trellis2Conditioning", inputs: { clip_vision_model: ["15", 0], image: ["312", 0] } },
        "40": { class_type: "UNETLoader", inputs: { unet_name: f.unet, weight_dtype: "default" } },
        "199": { class_type: "CFGOverride", inputs: { model: ["40", 0], cfg: 1, start_percent: 0.667, end_percent: 1 } },
        "125": { class_type: "RescaleCFG", inputs: { model: ["199", 0], multiplier: 0.7 } },
        "108": { class_type: "ModelSamplingSD3", inputs: { model: ["125", 0], shift: 5 } },
        "87": { class_type: "EmptyTrellis2LatentStructure", inputs: { batch_size: 1 } },
        "3": {
            class_type: "KSampler",
            _meta: { title: "Structure Sampler" },
            inputs: { model: ["108", 0], seed: seed(0), steps: 12, cfg: 7.5, sampler_name: "euler", scheduler: "normal", positive: ["299", 0], negative: ["299", 1], latent_image: ["87", 0], denoise: 1 },
        },
        "117": { class_type: "VAELoader", inputs: { vae_name: f.shapeVae } },
        "119": { class_type: "VaeDecodeStructureTrellis2", inputs: { samples: ["3", 0], vae: ["117", 0], resolution: "32" } },
        "91": { class_type: "Trellis2ShapeStage", inputs: { positive: ["299", 0], negative: ["299", 1], voxel: ["119", 0] } },
        "279": { class_type: "CFGOverride", inputs: { model: ["40", 0], cfg: 1, start_percent: 0.769, end_percent: 1 } },
        "126": { class_type: "RescaleCFG", inputs: { model: ["279", 0], multiplier: 0.5 } },
        "18": {
            class_type: "KSampler",
            _meta: { title: "Shape Sampler" },
            inputs: { model: ["126", 0], seed: seed(1), steps: 20, cfg: 7.5, sampler_name: "euler", scheduler: "normal", positive: ["91", 0], negative: ["91", 1], latent_image: ["91", 2], denoise: 1 },
        },
        "94": { class_type: "Trellis2UpsampleStage", inputs: { positive: ["91", 0], negative: ["91", 1], shape_latent: ["18", 0], vae: ["117", 0], target_resolution: 1536 } },
        "23": {
            class_type: "KSampler",
            _meta: { title: "Upsample Sampler" },
            inputs: { model: ["126", 0], seed: seed(2), steps: 12, cfg: 7.5, sampler_name: "euler", scheduler: "simple", positive: ["94", 0], negative: ["94", 1], latent_image: ["94", 2], denoise: 1 },
        },
        "92": { class_type: "VaeDecodeShapeTrellis", inputs: { samples: ["23", 0], vae: ["117", 0] } },
        "98": { class_type: "Trellis2TextureStage", inputs: { positive: ["94", 0], negative: ["94", 1], shape_latent: ["23", 0] } },
        "12": {
            class_type: "KSampler",
            _meta: { title: "Texture Sampler" },
            inputs: { model: ["40", 0], seed: seed(3), steps: 12, cfg: 1, sampler_name: "euler", scheduler: "normal", positive: ["98", 0], negative: ["98", 1], latent_image: ["98", 2], denoise: 1 },
        },
        "118": { class_type: "VAELoader", inputs: { vae_name: f.textureVae } },
        "93": { class_type: "VaeDecodeTextureTrellis", inputs: { samples: ["12", 0], vae: ["118", 0], shape_subdivides: ["92", 1] } },
        "241": {
            class_type: "RemeshMesh",
            inputs: {
                mesh: ["92", 0],
                resolution: 768,
                sign_mode: "udf",
                "sign_mode.qef": false,
                "sign_mode.drop_inverted_components": false,
                "sign_mode.drop_enclosed_components": false,
                band: 1,
                project_back: 0,
                fix_poles: false,
                smooth_iters: 20,
                drop_small_components: 0.01,
                precluster_max_verts: 20000000,
            },
        },
        "186": { class_type: "DecimateMesh", inputs: { mesh: ["241", 0], target_face_count: o.faceCount, placement_mode: "midpoint" } },
        "238": { class_type: "MeshSmoothNormals", inputs: { mesh: ["186", 0], crease_angle: 180 } },
        "196": { class_type: "UnwrapMesh", inputs: { mesh: ["238", 0], segmenter: "pec", resolution: o.textureSize, padding: 1, weld_distance: 0.0002 } },
        "147": { class_type: "BakeTextureFromVoxel", inputs: { mesh: ["196", 0], voxel_colors: ["93", 0], texture_size: o.textureSize, reference_mesh: ["92", 0] } },
        "224": { class_type: "BakeNormalMapFromMesh", inputs: { low_poly: ["196", 0], high_poly: ["241", 0], resolution: o.textureSize, cage_distance: 0.05, ignore_backfaces: true } },
        "233": { class_type: "BakeAmbientOcclusion", inputs: { low_poly: ["196", 0], high_poly: ["241", 0], resolution: Math.min(o.textureSize, 2048), samples: 64, max_distance: 0.71, strength: 1, bias: 0.01 } },
        "210": { class_type: "ApplyTextureToMesh", inputs: { mesh: ["196", 0], base_color: ["147", 0], metallic: ["147", 1], roughness: ["147", 2], occlusion: ["233", 0], normal_map: ["224", 0] } },
        "260": { class_type: "MeshSmoothNormals", inputs: { mesh: ["210", 0], crease_angle: 180 } },
        [SAVE_NODE]: { class_type: "SaveGLB", _meta: { title: "Save for Photoshop" }, inputs: { mesh: ["260", 0], filename_prefix: o.filenamePrefix ?? "photoshop3d/trellis2" } },
    };
    if (o.useAlphaMask) {
        // LoadImage outputs 1 - alpha as its mask; invert it to get the object.
        wf["195"] = { class_type: "InvertMask", inputs: { mask: ["122", 1] } };
    } else {
        wf["193"] = { class_type: "LoadBackgroundRemovalModel", inputs: { bg_removal_name: f.backgroundRemoval } };
        wf["192"] = { class_type: "RemoveBackground", inputs: { bg_removal_model: ["193", 0], image: ["122", 0] } };
    }
    return wf;
}

/* ------------------------------------------------------------ custom workflows */

export function isApiWorkflow(value: unknown): value is ApiWorkflow {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const nodes = Object.values(value as Record<string, unknown>);
    return nodes.length > 0 && nodes.every((n) => !!n && typeof n === "object" && typeof (n as ApiNode).class_type === "string" && typeof (n as ApiNode).inputs === "object");
}

/** True for a workflow saved with Workflow → Save (UI format), which /prompt cannot run. */
export function isUiWorkflow(value: unknown): boolean {
    return !!value && typeof value === "object" && Array.isArray((value as { nodes?: unknown }).nodes) && Array.isArray((value as { links?: unknown }).links);
}

export type ImageNodeCandidate = { id: string; title: string };

export function imageNodeCandidates(wf: ApiWorkflow): ImageNodeCandidate[] {
    return Object.entries(wf)
        .filter(([, n]) => /LoadImage/i.test(n.class_type) && typeof n.inputs.image === "string")
        .map(([id, n]) => ({ id, title: n._meta?.title ?? n.class_type }));
}

/** The LoadImage node that receives the layer: the chosen one, the only one, or one titled "Photoshop"/"input". */
export function pickImageNode(wf: ApiWorkflow, preferred: string): string {
    const candidates = imageNodeCandidates(wf);
    if (preferred && candidates.some((c) => c.id === preferred)) return preferred;
    if (candidates.length === 1) return candidates[0].id;
    const titled = candidates.filter((c) => /photoshop|input|source/i.test(c.title));
    if (titled.length === 1) return titled[0].id;
    if (!candidates.length) throw new Error("This workflow has no Load Image node to receive the layer.");
    throw new Error(`This workflow has ${candidates.length} Load Image nodes (${candidates.map((c) => `#${c.id} ${c.title}`).join(", ")}). Pick one in Settings → ComfyUI.`);
}

/** Copy of a custom workflow with the uploaded image and seeds filled in. */
export function prepareCustomWorkflow(wf: ApiWorkflow, image: string, imageNodeId: string, seed: number): ApiWorkflow {
    const out = JSON.parse(JSON.stringify(wf)) as ApiWorkflow;
    const id = pickImageNode(out, imageNodeId);
    out[id].inputs.image = image;
    for (const node of Object.values(out)) {
        for (const key of ["seed", "noise_seed"]) if (typeof node.inputs[key] === "number") node.inputs[key] = seed;
    }
    return out;
}

/* ------------------------------------------------------------------ results */

export type ComfyFile = { filename: string; subfolder: string; type: string };
const MODEL_EXT = /\.(glb|gltf)$/i;

/**
 * 3D files in a /history entry's outputs. SaveGLB and Save3DAdvanced report
 * { "3d": [{filename, subfolder, type}] }; older Preview3D nodes report a path string
 * in "result"; custom nodes vary, so every array is scanned.
 */
export function modelFilesFromOutputs(outputs: unknown): ComfyFile[] {
    const files: ComfyFile[] = [];
    if (!outputs || typeof outputs !== "object") return files;
    for (const nodeOut of Object.values(outputs as Record<string, unknown>)) {
        if (!nodeOut || typeof nodeOut !== "object") continue;
        for (const value of Object.values(nodeOut as Record<string, unknown>)) {
            if (!Array.isArray(value)) continue;
            for (const item of value) {
                if (item && typeof item === "object" && typeof (item as ComfyFile).filename === "string" && MODEL_EXT.test((item as ComfyFile).filename)) {
                    const f = item as ComfyFile;
                    files.push({ filename: f.filename, subfolder: f.subfolder ?? "", type: f.type ?? "output" });
                } else if (typeof item === "string" && MODEL_EXT.test(item.replace(/\s*\[(output|input|temp)\]$/, ""))) {
                    const clean = item.replace(/\s*\[(output|input|temp)\]$/, "");
                    const parts = clean.split(/[\\/]/);
                    const filename = parts.pop()!;
                    files.push({ filename, subfolder: parts.join("/"), type: "output" });
                }
            }
        }
    }
    return files;
}

/** Error text for a failed /history entry; null when it did not fail. */
export function historyError(entry: unknown): string | null {
    const status = (entry as { status?: { status_str?: string; messages?: [string, Record<string, unknown>][] } })?.status;
    if (!status || status.status_str !== "error") return null;
    for (const [type, data] of status.messages ?? []) {
        if (type === "execution_error") return `${String(data.node_type ?? "Node")}: ${String(data.exception_message ?? "failed").trim()}`;
        if (type === "execution_interrupted") return "Cancelled in ComfyUI.";
    }
    return "The ComfyUI workflow failed.";
}

/** Message for a rejected POST /prompt (validation errors, missing models). */
export function promptError(body: unknown): string {
    if (typeof body === "string") return body;
    const b = (body ?? {}) as { error?: { message?: string; details?: string }; node_errors?: Record<string, { class_type?: string; errors?: { message?: string; details?: string }[] }> };
    const lines = [b.error?.message ?? "ComfyUI rejected the workflow."];
    for (const node of Object.values(b.node_errors ?? {})) {
        for (const err of node.errors ?? []) lines.push(`${node.class_type ?? "Node"}: ${err.message ?? ""}${err.details ? ` (${err.details})` : ""}`);
    }
    return lines.join("\n");
}
