import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { PNG_1PX, bytes, context, fakeGlb, json, route, scriptedFetch } from "../../../tests/unit/helpers";
import { MemoryFileStore, readJson, writeJson } from "../platform/fileStore";
import { MemoryLogger, redact } from "../platform/logger";
import { MemorySecretStore } from "../platform/secrets";
import { appDataRoot, sharedFolderPath, toBrowserFileUrl, toUxpFileUrl } from "../platform/sharedFolder";
import { multipartBody } from "../platform/http";
import { BridgeServer, type Handlers } from "../bridge/server";
import { Library } from "./library";
import { TaskHistory } from "./history";
import { JobManager, isTransient } from "./jobs";
import { BrowseService } from "./browse";
import { SettingsService } from "./settingsService";
import { Updater, pickRelease } from "./updater";
import { HttpError } from "../platform/http";
import type { PollResult, ProviderAdapter } from "../providers/types";
import { buildTrellis2Workflow, imageNodeCandidates, isApiWorkflow, isUiWorkflow, modelFilesFromOutputs, pickImageNode, prepareCustomWorkflow } from "../providers/comfyWorkflows";

describe("file store", () => {
    it("writes JSON safely and recovers from a corrupt main file", async () => {
        const store = new MemoryFileStore();
        await writeJson(store, "a/b.json", { x: 1 });
        expect(await readJson(store, "a/b.json")).toEqual({ x: 1 });
        await store.writeText("a/b.json", "{broken");
        expect(await readJson(store, "a/b.json")).toEqual({ x: 1 }); // from the .tmp copy
        expect((await store.list("a")).sort((x, y) => x.name.localeCompare(y.name))).toEqual([
            { name: "b.json", isFolder: false },
            { name: "b.json.tmp", isFolder: false },
        ]);
        await store.remove("a");
        expect(await store.exists("a/b.json")).toBe(false);
        expect(() => store.nativePath("../x")).toThrow();
    });
});

describe("library", () => {
    it("adds, updates, thumbnails and removes models", async () => {
        const store = new MemoryFileStore();
        let t = 1000;
        const lib = new Library(store, new MemoryLogger(), () => t++);
        const changes: number[] = [];
        lib.onChange((items) => changes.push(items.length));
        const item = await lib.add({ name: "  Chair ", origin: "meshy", remoteId: "r1", model: fakeGlb(), thumbnail: PNG_1PX, source: PNG_1PX });
        expect(item).toMatchObject({ name: "Chair", format: "glb", modelFile: `${item.id}/model.glb`, thumbFile: `${item.id}/thumb.png`, sourceFile: `${item.id}/source.png` });
        expect(await store.exists(`library/${item.id}/info.json`)).toBe(true);
        expect(lib.findByRemote("meshy", "r1")?.id).toBe(item.id);
        await lib.update(item.id, { name: "Throne", favorite: true });
        await lib.setThumbnail(item.id, PNG_1PX);
        await expect(lib.setThumbnail(item.id, fakeGlb())).rejects.toThrow(/PNG/);
        await expect(lib.add({ name: "x", origin: "local", model: PNG_1PX })).rejects.toThrow(/not a glTF/);

        const reloaded = new Library(store, new MemoryLogger());
        await reloaded.load();
        expect(reloaded.list()[0]).toMatchObject({ name: "Throne", favorite: true });

        await lib.remove(item.id);
        expect(lib.list()).toHaveLength(0);
        expect(await store.exists(`library/${item.id}`)).toBe(false);
        expect(changes).toEqual([1, 1, 1, 0]);
    });

    it("drops index entries whose files were deleted by hand", async () => {
        const store = new MemoryFileStore();
        const lib = new Library(store, new MemoryLogger());
        const a = await lib.add({ name: "A", origin: "local", model: fakeGlb() });
        await lib.add({ name: "B", origin: "local", model: fakeGlb() });
        await store.remove(`library/${a.id}/model.glb`);
        const reloaded = new Library(store, new MemoryLogger());
        await reloaded.load();
        expect(reloaded.list().map((i) => i.name)).toEqual(["B"]);
    });

    it("serialises concurrent adds", async () => {
        const lib = new Library(new MemoryFileStore(), new MemoryLogger());
        await Promise.all(Array.from({ length: 5 }, (_, i) => lib.add({ name: `M${i}`, origin: "local", model: fakeGlb() })));
        expect(lib.list()).toHaveLength(5);
    });
});

/** A provider whose poll answers come from a script. */
function fakeProvider(polls: (PollResult | Error)[], opts: { submitError?: Error; submitErrors?: Error[]; cancel?: boolean } = {}): ProviderAdapter & { submitted: number; cancelled: string[] } {
    const p = {
        id: "meshy" as const,
        label: "Fake",
        capabilities: { generate: true, browse: false, cancel: !!opts.cancel },
        submitted: 0,
        cancelled: [] as string[],
        async isConfigured() {
            return { configured: true };
        },
        async test() {
            return { ok: true, message: "ok" };
        },
        async submit() {
            p.submitted++;
            if (opts.submitError) throw opts.submitError;
            const once = opts.submitErrors?.shift();
            if (once) throw once;
            return { remoteId: `r${p.submitted}`, meta: { kind: "image-to-3d" } };
        },
        async poll() {
            const next = polls.shift();
            if (!next) return { state: "running" as const };
            if (next instanceof Error) throw next;
            return next;
        },
        async resolve() {
            return { modelUrl: "https://cdn/fresh.glb", format: "glb" as const };
        },
        cancel: opts.cancel
            ? async (_ctx: unknown, id: string) => {
                  p.cancelled.push(id);
              }
            : undefined,
    };
    return p as unknown as ProviderAdapter & { submitted: number; cancelled: string[] };
}

function jobSetup(provider: ProviderAdapter, files: Record<string, Uint8Array> = {}) {
    const store = new MemoryFileStore();
    const log = new MemoryLogger();
    const library = new Library(store, log);
    const history = new TaskHistory(store);
    let now = 1_000_000;
    const fetch = scriptedFetch([
        route("GET", /\.glb$/, (call) => bytes(files[call.url] ?? fakeGlb())),
        route("GET", /\.png$/, () => bytes(PNG_1PX)),
        route("GET", /expired/, () => new Response("no", { status: 403 })),
    ]);
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    const jobs = new JobManager({ store, log, library, history, fetch, provider: () => provider, context: () => context(fetch), now: () => now, tickMs: 0, sleep });
    return { store, log, library, history, jobs, fetch, sleeps, advance: (ms: number) => (now += ms) };
}

const startInput = { providerId: "meshy" as const, image: PNG_1PX, width: 1, height: 1, hasAlpha: true, name: "Chair" };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("job manager", () => {
    it("runs submit → poll → download → library", async () => {
        const provider = fakeProvider([
            { state: "queued", progress: 0 },
            { state: "running", progress: 40, message: "Generating" },
            { state: "succeeded", progress: 100, result: { modelUrl: "https://cdn/m.glb", format: "glb", thumbnailUrl: "https://cdn/t.png", name: "Chair" } },
        ]);
        const s = jobSetup(provider);
        const job = await s.jobs.start(startInput);
        await flush();
        expect(s.jobs.get(job.id)).toMatchObject({ status: "running", remoteId: "r1" });
        for (let i = 0; i < 3; i++) {
            s.advance(20_000);
            await s.jobs.tick();
        }
        const done = s.jobs.get(job.id)!;
        expect(done).toMatchObject({ status: "succeeded", progress: 100 });
        const item = s.library.get(done.libraryId!)!;
        expect(item).toMatchObject({ name: "Chair", origin: "meshy", remoteId: "r1" });
        expect(item.thumbFile).toBeTruthy();
        expect(item.sourceFile).toBeTruthy();
        expect(await s.store.exists(`jobs/${job.id}`)).toBe(false);
        expect((await s.history.forProvider("meshy"))[0].remoteId).toBe("r1");
    });

    it("backs off while nothing changes", async () => {
        const provider = fakeProvider([{ state: "running", progress: 10 }, { state: "running", progress: 10 }, { state: "running", progress: 10 }]);
        const s = jobSetup(provider);
        const job = await s.jobs.start(startInput);
        await flush();
        s.advance(5000);
        await s.jobs.tick();
        expect(s.jobs.get(job.id)!.pollDelayMs).toBe(2000); // progress changed 0 → 10
        s.advance(5000);
        await s.jobs.tick();
        expect(s.jobs.get(job.id)!.pollDelayMs).toBe(3000);
        s.advance(5000);
        await s.jobs.tick();
        expect(s.jobs.get(job.id)!.pollDelayMs).toBe(4500);
    });

    it("retries transient poll errors and fails on hard ones", async () => {
        expect(isTransient(new HttpError("x", 503, null, "u"))).toBe(true);
        expect(isTransient(new HttpError("x", 401, null, "u"))).toBe(false);
        const provider = fakeProvider([new Error("network down"), new HttpError("Unauthorized", 401, null, "u")]);
        const s = jobSetup(provider);
        const job = await s.jobs.start(startInput);
        await flush();
        s.advance(5000);
        await s.jobs.tick();
        expect(s.jobs.get(job.id)).toMatchObject({ status: "running", pollErrors: 1 });
        s.advance(60_000);
        await s.jobs.tick();
        expect(s.jobs.get(job.id)).toMatchObject({ status: "failed", error: "Unauthorized" });
    });

    it("waits out a rate limit on submit for as long as the service asks", async () => {
        const provider = fakeProvider([], { submitErrors: [new HttpError("Tripo error 429: concurrency limit", 429, null, "u", 7000)] });
        const s = jobSetup(provider);
        const job = await s.jobs.start(startInput);
        await flush();
        await flush();
        expect(s.sleeps).toEqual([7000]);
        expect(s.jobs.get(job.id)).toMatchObject({ status: "running", remoteId: "r2" });
    });

    it("slows polling down on a rate limit without counting it as an error", async () => {
        const provider = fakeProvider([new HttpError("Meshy error 429", 429, null, "u", 30_000), { state: "running", progress: 20 }]);
        const s = jobSetup(provider);
        const job = await s.jobs.start(startInput);
        await flush();
        s.advance(5000);
        await s.jobs.tick();
        const waiting = s.jobs.get(job.id)!;
        expect(waiting.status).toBe("running");
        expect(waiting.pollErrors ?? 0).toBe(0);
        expect(waiting.pollDelayMs).toBe(30_000);
        expect(waiting.message).toMatch(/slow down/);
        s.advance(31_000);
        await s.jobs.tick();
        expect(s.jobs.get(job.id)).toMatchObject({ status: "running", progress: 20 });
    });

    it("retries a failed submission from the saved source image", async () => {
        const provider = fakeProvider([], { submitError: new Error("TextEncoder is not defined") });
        const s = jobSetup(provider);
        const job = await s.jobs.start(startInput);
        await flush();
        expect(s.jobs.get(job.id)).toMatchObject({ status: "failed", error: "TextEncoder is not defined" });
        (provider as unknown as { submit: () => Promise<unknown> }).submit = async () => ({ remoteId: "r9" });
        await s.jobs.retry(job.id);
        await flush();
        expect(s.jobs.get(job.id)).toMatchObject({ status: "running", remoteId: "r9" });
    });

    it("re-resolves fresh links when a download failed", async () => {
        const provider = fakeProvider([{ state: "succeeded", result: { modelUrl: "https://cdn/expired", format: "glb" } }]);
        const s = jobSetup(provider);
        const job = await s.jobs.start(startInput);
        await flush();
        s.advance(5000);
        await s.jobs.tick();
        expect(s.jobs.get(job.id)).toMatchObject({ status: "failed" });
        expect(s.jobs.get(job.id)!.error).toMatch(/expired/);
        await s.jobs.retry(job.id);
        await flush();
        await flush();
        expect(s.jobs.get(job.id)).toMatchObject({ status: "succeeded" });
    });

    it("resumes active jobs after a restart and fails interrupted submissions", async () => {
        const provider = fakeProvider([{ state: "succeeded", result: { modelUrl: "https://cdn/m.glb", format: "glb" } }]);
        const s = jobSetup(provider);
        await writeJson(s.store, "jobs.json", {
            jobs: [
                { id: "j1", providerId: "meshy", remoteId: "r1", name: "A", status: "running", progress: 30, createdAt: 1, updatedAt: 1 },
                { id: "j2", providerId: "meshy", name: "B", status: "submitting", progress: 0, createdAt: 2, updatedAt: 2 },
            ],
        });
        await s.jobs.load();
        expect(s.jobs.get("j2")).toMatchObject({ status: "failed" });
        await s.jobs.tick();
        expect(s.jobs.get("j1")).toMatchObject({ status: "succeeded" });
    });

    it("cancels through the provider when it can", async () => {
        const provider = fakeProvider([], { cancel: true });
        const s = jobSetup(provider);
        const job = await s.jobs.start(startInput);
        await flush();
        await s.jobs.cancel(job.id);
        expect(provider.cancelled).toEqual(["r1"]);
        expect(s.jobs.get(job.id)!.status).toBe("cancelled");
        await s.jobs.dismiss(job.id);
        expect(s.jobs.get(job.id)).toBeUndefined();
    });

    it("tracks an existing provider task by id", async () => {
        const provider = fakeProvider([{ state: "succeeded", result: { modelUrl: "https://cdn/m.glb", format: "glb" } }]);
        const s = jobSetup(provider);
        const job = await s.jobs.recover("meshy", " abc ");
        expect(job.remoteId).toBe("abc");
        await s.jobs.tick();
        expect(s.jobs.get(job.id)!.status).toBe("succeeded");
    });
});

describe("browse", () => {
    it("falls back to the task history for providers without a list API", async () => {
        const provider = fakeProvider([{ state: "succeeded", result: { modelUrl: "https://cdn/m.glb", format: "glb", thumbnailUrl: "https://cdn/c.png" } }]);
        const s = jobSetup(provider);
        await s.history.record({ providerId: "meshy", remoteId: "h1", name: "From history", createdAt: 5 });
        const browse = new BrowseService({ library: s.library, history: s.history, log: s.log, fetch: s.fetch, provider: () => provider, context: () => context(s.fetch) });
        const page = await browse.list("meshy", 1, 10);
        expect(page.items[0]).toMatchObject({ remoteId: "h1", status: "succeeded", hasModel: true, thumbnailUrl: "https://cdn/c.png" });
        const item = await browse.import("meshy", "h1");
        expect(item.name).toBe("From history");
        expect((await browse.list("meshy", 1, 10)).items[0].libraryId).toBe(item.id);
        expect((await browse.import("meshy", "h1")).id).toBe(item.id); // no duplicate
    });
});

describe("settings service", () => {
    it("keeps secrets out of settings.json and exposes previews", async () => {
        const store = new MemoryFileStore();
        const secrets = new MemorySecretStore();
        const svc = new SettingsService(store, secrets, new MemoryLogger());
        await svc.load();
        const pub = await svc.setSecret("meshy.apiKey", "msy_supersecretvalue");
        expect(pub.secrets["meshy.apiKey"]).toEqual({ set: true, preview: "msy_…alue" });
        await svc.update({ meshy: { enablePbr: false } });
        expect(await store.readText("settings.json")).not.toContain("supersecret");
        await expect(svc.setSecret("bogus" as never, "x")).rejects.toThrow();
        const reset = await svc.reset();
        expect(reset.meshy.enablePbr).toBe(true);
        expect(reset.secrets["meshy.apiKey"].set).toBe(true);
    });
});

describe("updater", () => {
    const release = (tag: string, extra: Partial<{ prerelease: boolean; draft: boolean; assets: { name: string; browser_download_url: string; size: number }[] }> = {}) => ({
        tag_name: tag,
        name: tag,
        body: "notes",
        html_url: `https://github.com/x/y/releases/${tag}`,
        draft: false,
        prerelease: false,
        published_at: "2026-10-02",
        assets: [
            { name: `geekatplay-3d-layers-${tag.slice(1)}.ccx`, browser_download_url: `https://dl/${tag}.ccx`, size: 10 },
            { name: "SHA256SUMS.txt", browser_download_url: `https://dl/${tag}.sums`, size: 1 },
        ],
        ...extra,
    });

    it("picks the newest usable release", () => {
        const list = [release("v0.2.0"), release("v0.3.0-beta.1", { prerelease: true }), release("v0.1.0"), release("v0.4.0", { draft: true }), release("v0.5.0", { assets: [] })];
        expect(pickRelease(list, false)?.tag_name).toBe("v0.2.0");
        expect(pickRelease(list, true)?.tag_name).toBe("v0.3.0-beta.1");
    });

    async function makeUpdater(fetch: ReturnType<typeof scriptedFetch>, current = "0.1.0") {
        const store = new MemoryFileStore();
        const settings = new SettingsService(store, new MemorySecretStore(), new MemoryLogger());
        await settings.load();
        const saved: { name: string; bytes: Uint8Array }[] = [];
        const opened: string[] = [];
        const updater = new Updater({
            fetch,
            log: new MemoryLogger(),
            settings,
            currentVersion: current,
            saveTemp: async (name, b) => {
                saved.push({ name, bytes: b });
                return `/tmp/${name}`;
            },
            openPath: async (p) => {
                opened.push(p);
            },
            now: () => 100_000_000_000,
        });
        return { updater, settings, saved, opened };
    }

    it("reports an available update and installs a verified package", async () => {
        const ccx = new Uint8Array([1, 2, 3, 4]);
        const sum = createHash("sha256").update(ccx).digest("hex");
        const fetch = scriptedFetch([
            route("GET", "https://api.github.com/repos/GeekatplayStudio/Photoshop-3D/releases/latest", () => json(release("v0.2.0"))),
            route("GET", "https://dl/v0.2.0.ccx", () => bytes(ccx)),
            route("GET", "https://dl/v0.2.0.sums", () => new Response(`${sum}  geekatplay-3d-layers-0.2.0.ccx\n`)),
        ]);
        const { updater, settings, saved, opened } = await makeUpdater(fetch);
        expect(updater.isDue()).toBe(true);
        const info = await updater.check();
        expect(info).toMatchObject({ available: true, latestVersion: "0.2.0", downloadUrl: "https://dl/v0.2.0.ccx" });
        expect(settings.value.updates.lastCheckAt).toBe(100_000_000_000);
        expect(updater.isDue()).toBe(false);
        const res = await updater.install();
        expect(res.started).toBe(true);
        expect(saved[0].name).toBe("geekatplay-3d-layers-0.2.0.ccx");
        expect(opened).toEqual(["/tmp/geekatplay-3d-layers-0.2.0.ccx"]);
    });

    it("refuses a package whose checksum does not match", async () => {
        const fetch = scriptedFetch([
            route("GET", /releases\/latest$/, () => json(release("v0.2.0"))),
            route("GET", "https://dl/v0.2.0.ccx", () => bytes(new Uint8Array([9, 9]))),
            route("GET", "https://dl/v0.2.0.sums", () => new Response(`${"0".repeat(64)}  geekatplay-3d-layers-0.2.0.ccx\n`)),
        ]);
        const { updater, opened } = await makeUpdater(fetch);
        await expect(updater.install()).rejects.toThrow(/corrupted/);
        expect(opened).toEqual([]);
    });

    it("explains what to do when Photoshop's open-file prompt is blocked", async () => {
        const ccx = new Uint8Array([7, 7, 7]);
        const sum = createHash("sha256").update(ccx).digest("hex");
        const fetch = scriptedFetch([
            route("GET", /releases\/latest$/, () => json(release("v0.2.0"))),
            route("GET", "https://dl/v0.2.0.ccx", () => bytes(ccx)),
            route("GET", "https://dl/v0.2.0.sums", () => new Response(`${sum}  geekatplay-3d-layers-0.2.0.ccx\n`)),
        ]);
        const { updater } = await makeUpdater(fetch);
        (updater as unknown as { deps: { openPath: () => Promise<void> } }).deps.openPath = async () => {
            throw new Error("User denied.");
        };
        await expect(updater.install()).rejects.toThrow(/did not open the installer \(User denied\.\).*choose "Allow"/);
    });

    it("handles no releases and being up to date", async () => {
        const none = await makeUpdater(scriptedFetch([route("GET", /releases\/latest$/, () => json({ message: "Not Found" }, 404))]));
        const noneInfo = await none.updater.check();
        expect(noneInfo.available).toBe(false);
        expect(noneInfo.error).toBeUndefined();
        const same = await makeUpdater(scriptedFetch([route("GET", /releases\/latest$/, () => json(release("v0.1.0")))]));
        expect((await same.updater.check()).available).toBe(false);
        expect(await same.updater.install()).toEqual({ started: false, message: "You already have the latest version." });
    });
});

describe("bridge server", () => {
    it("dispatches requests and reports errors", async () => {
        const sent: unknown[] = [];
        const handlers: Handlers = {
            "app.info": () => ({ pluginVersion: "1" }) as never,
            "jobs.cancel": () => {
                throw new Error("nope");
            },
        };
        const server = new BridgeServer("panel", { postMessage: (m) => sent.push(m) }, handlers, new MemoryLogger());
        await server.handle({ t: "req", id: 1, method: "app.info", params: null });
        await server.handle(JSON.stringify({ t: "req", id: 2, method: "jobs.cancel", params: { id: "x" } }));
        await server.handle({ t: "req", id: 3, method: "nope", params: null });
        await server.handle({ unrelated: true });
        server.emit("toast", { kind: "info", message: "hi" });
        expect(sent).toEqual([
            { t: "res", id: 1, ok: true, result: { pluginVersion: "1" } },
            { t: "res", id: 2, ok: false, error: { message: "nope" } },
            { t: "res", id: 3, ok: false, error: { message: "Unknown bridge method: nope" } },
            { t: "evt", name: "toast", data: { kind: "info", message: "hi" } },
        ]);
        server.close();
        server.emit("toast", { kind: "info", message: "after close" });
        expect(sent).toHaveLength(4);
    });
});

describe("logging", () => {
    it("never writes credentials", () => {
        expect(redact('Authorization: "Bearer msy_abcdefghijk"')).not.toContain("msy_abcdefghijk");
        expect(redact("key tsk_1234567890abcd used")).toBe("key tsk_*** used");
        expect(redact('{"apiKey":"secret123","x":1}')).toBe('{"apiKey":"***","x":1}');
        expect(redact("Basic QUs6U0s=")).toBe("Basic QUs6U0s="); // no header name → untouched text
        expect(redact("authorization=Basic QUs6U0s=")).toBe("authorization=Basic ***");
    });
    it("keeps a tail in memory", () => {
        const log = new MemoryLogger();
        log.info("a");
        log.error("b", new Error("boom"));
        expect(log.tail(1)).toContain("boom");
    });
});

describe("shared user-data folder", () => {
    it("derives a stable folder next to Adobe's UXP storage", () => {
        const win = "C:\\Users\\Ann Lee\\AppData\\Roaming\\Adobe\\UXP\\PluginsStorage\\PHSP\\27\\External\\com.geekatplay.photoshop3d\\PluginData";
        expect(appDataRoot(win)).toBe("C:\\Users\\Ann Lee\\AppData\\Roaming");
        expect(sharedFolderPath(win)).toBe("C:\\Users\\Ann Lee\\AppData\\Roaming\\Geekatplay\\3D Layers");
        const mac = "/Users/ann/Library/Application Support/Adobe/UXP/PluginsStorage/PHSP/26/External/x/PluginData";
        expect(sharedFolderPath(mac)).toBe("/Users/ann/Library/Application Support/Geekatplay/3D Layers");
        expect(sharedFolderPath("/somewhere/else")).toBeNull();
    });
    it("builds UXP and browser file URLs", () => {
        expect(toUxpFileUrl("C:\\Users\\a b\\x")).toBe("file:/C:/Users/a b/x");
        expect(toUxpFileUrl("/Users/a/x")).toBe("file:/Users/a/x");
        expect(toBrowserFileUrl("C:\\Users\\Ann Lee\\Geekatplay\\3D Layers\\library")).toBe("file:///C:/Users/Ann%20Lee/Geekatplay/3D%20Layers/library");
        expect(toBrowserFileUrl("/Users/ann/Library/Application Support/x")).toBe("file:///Users/ann/Library/Application%20Support/x");
    });
});

describe("multipart", () => {
    it("builds a correct form body", () => {
        const { body, contentType } = multipartBody([
            { name: "f", value: "v" },
            { name: "file", value: new Uint8Array([1, 2]), filename: "a.png", contentType: "image/png" },
        ]);
        const text = Buffer.from(body).toString("latin1");
        const boundary = contentType.split("boundary=")[1];
        expect(text).toContain(`--${boundary}\r\nContent-Disposition: form-data; name="f"\r\n\r\nv\r\n`);
        expect(text).toContain('filename="a.png"\r\nContent-Type: image/png\r\n\r\n\u0001\u0002\r\n');
        expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
    });
});

describe("ComfyUI workflows", () => {
    it("builds TRELLIS.2 with BiRefNet or the layer's alpha", () => {
        const bg = buildTrellis2Workflow({ image: "a.png", useAlphaMask: false, textureSize: 1024, faceCount: 100000, seed: 1 });
        expect(bg["192"].class_type).toBe("RemoveBackground");
        expect(bg["312"].inputs.masks).toEqual(["192", 0]);
        expect(bg["195"]).toBeUndefined();
        const alpha = buildTrellis2Workflow({ image: "a.png", useAlphaMask: true, textureSize: 4096, faceCount: 100000, seed: 2 ** 48 - 1 });
        expect(alpha["312"].inputs.masks).toEqual(["195", 0]);
        expect(alpha["147"].inputs.texture_size).toBe(4096);
        expect(alpha["233"].inputs.resolution).toBe(2048);
        expect(alpha["18"].inputs.seed).toBe(0); // wraps instead of overflowing
        // Every link points at a node that exists.
        for (const node of Object.values(alpha)) {
            for (const v of Object.values(node.inputs)) if (Array.isArray(v)) expect(alpha[v[0] as string], JSON.stringify(v)).toBeDefined();
        }
        expect(isApiWorkflow(alpha)).toBe(true);
    });

    it("finds the image node and fills custom workflows", () => {
        const wf = {
            "1": { class_type: "LoadImage", inputs: { image: "x.png" }, _meta: { title: "Reference" } },
            "2": { class_type: "LoadImage", inputs: { image: "y.png" }, _meta: { title: "Photoshop input" } },
            "3": { class_type: "KSampler", inputs: { seed: 1, noise_seed: 2 } },
        };
        expect(imageNodeCandidates(wf)).toHaveLength(2);
        expect(pickImageNode(wf, "")).toBe("2");
        expect(pickImageNode(wf, "1")).toBe("1");
        const prepared = prepareCustomWorkflow(wf, "up.png", "", 42);
        expect(prepared["2"].inputs.image).toBe("up.png");
        expect(prepared["3"].inputs).toEqual({ seed: 42, noise_seed: 42 });
        expect(wf["2"].inputs.image).toBe("y.png"); // original untouched
        expect(() => pickImageNode({ "1": { class_type: "KSampler", inputs: {} } }, "")).toThrow(/no Load Image/);
        expect(isUiWorkflow({ nodes: [], links: [] })).toBe(true);
        expect(isApiWorkflow({ nodes: [] })).toBe(false);
    });

    it("collects 3D files from all output shapes", () => {
        expect(
            modelFilesFromOutputs({
                "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] },
                "10": { "3d": [{ filename: "m.glb", subfolder: "3d", type: "output" }] },
                "11": { result: ["sub/dir/old.gltf", { camera: 1 }] },
            }),
        ).toEqual([
            { filename: "m.glb", subfolder: "3d", type: "output" },
            { filename: "old.gltf", subfolder: "sub/dir", type: "output" },
        ]);
    });
});

vi.setConfig({ testTimeout: 10_000 });
