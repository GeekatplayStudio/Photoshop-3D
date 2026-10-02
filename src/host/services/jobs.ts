/**
 * The generation queue: submit → poll → download → library.
 *
 * Jobs persist in <data folder>/jobs.json, so closing the panel or restarting
 * Photoshop never loses a running generation: on load, active jobs resume polling.
 * Polling starts every 2 s and backs off ×1.5 up to 15 s while nothing changes;
 * transient errors (network, 5xx, 429) are retried with longer waits, other 4xx fail
 * the job immediately. The layer pixels that were sent are kept in jobs/<id>/source.png
 * until the job finishes, so a failed submission can be retried without Photoshop.
 */
import { newId } from "@shared/bytes";
import { ACTIVE_JOB_STATUSES, type Job, type ProviderId, type SourceTarget } from "@shared/types";
import { HttpError, type FetchLike } from "../platform/http";
import { joinPath, readJson, writeJson, type FileStore } from "../platform/fileStore";
import type { Logger } from "../platform/logger";
import type { ModelResult, ProviderAdapter, ProviderContext } from "../providers/types";
import type { TaskHistory } from "./history";
import { importModelResult } from "./importer";
import type { Library } from "./library";

export const JOBS_FILE = "jobs.json";
const JOBS_DIR = "jobs";
const MIN_DELAY = 2000;
const MAX_DELAY = 15_000;
const MAX_POLL_ERRORS = 6;
const MAX_CONCURRENT_POLLS = 3;
const KEEP_FINISHED = 100;

export type JobDeps = {
    store: FileStore;
    log: Logger;
    library: Library;
    history: TaskHistory;
    fetch: FetchLike;
    provider: (id: ProviderId) => ProviderAdapter;
    context: () => ProviderContext;
    now?: () => number;
    /** Tick interval; tests drive `tick()` directly and pass 0. */
    tickMs?: number;
};

export type StartInput = {
    providerId: ProviderId;
    image: Uint8Array;
    width: number;
    height: number;
    hasAlpha: boolean;
    name: string;
    sourcePreview?: string;
    source?: SourceTarget;
};

const isActive = (j: Job) => ACTIVE_JOB_STATUSES.includes(j.status);

/** Transient = worth retrying: network failures, timeouts, 408/429/5xx. */
export function isTransient(err: unknown): boolean {
    if (err instanceof HttpError) return err.status === 408 || err.status === 429 || err.status >= 500;
    return true;
}

export class JobManager {
    private jobs: Job[] = [];
    private busy = new Set<string>();
    private listeners = new Set<(jobs: Job[]) => void>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly deps: JobDeps) {}

    private now() {
        return this.deps.now?.() ?? Date.now();
    }

    async load(): Promise<void> {
        const data = await readJson<{ jobs?: Job[] }>(this.deps.store, JOBS_FILE);
        this.jobs = Array.isArray(data?.jobs) ? data!.jobs : [];
        for (const job of this.jobs) {
            if (!isActive(job)) continue;
            if (!job.remoteId) {
                // Photoshop closed while uploading: we don't know if the provider got it.
                this.patch(job, { status: "failed", error: "Interrupted while submitting. Retry to send it again.", meta: { ...job.meta, failedStage: "submit" } });
            } else {
                this.patch(job, { status: job.status === "downloading" ? "running" : job.status, nextPollAt: this.now(), pollDelayMs: MIN_DELAY, pollErrors: 0 });
            }
        }
        this.persistSoon();
        this.ensureTimer();
    }

    list(): Job[] {
        return [...this.jobs].sort((a, b) => b.createdAt - a.createdAt);
    }

    get(id: string): Job | undefined {
        return this.jobs.find((j) => j.id === id);
    }

    onChange(fn: (jobs: Job[]) => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    dispose() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /* ----------------------------------------------------------- lifecycle */

    async start(input: StartInput): Promise<Job> {
        const provider = this.deps.provider(input.providerId);
        const configured = await provider.isConfigured(this.deps.context());
        if (!configured.configured) throw new Error(configured.hint ?? `${provider.label} is not set up yet.`);
        const job: Job = {
            id: newId("job"),
            providerId: input.providerId,
            name: input.name,
            status: "queued",
            progress: 0,
            message: "Preparing",
            createdAt: this.now(),
            updatedAt: this.now(),
            sourcePreview: input.sourcePreview,
            source: input.source,
            meta: { input: { width: input.width, height: input.height, hasAlpha: input.hasAlpha } },
        };
        await this.deps.store.writeBytes(joinPath(JOBS_DIR, job.id, "source.png"), input.image);
        this.jobs.push(job);
        this.trim();
        this.changed();
        void this.submit(job);
        return job;
    }

    private async submit(job: Job) {
        if (this.busy.has(job.id)) return;
        this.busy.add(job.id);
        const provider = this.deps.provider(job.providerId);
        try {
            const image = await this.deps.store.readBytes(joinPath(JOBS_DIR, job.id, "source.png"));
            if (!image) throw new Error("The image for this job is no longer available. Send the layer again.");
            const input = (job.meta?.input ?? {}) as { width?: number; height?: number; hasAlpha?: boolean };
            this.patch(job, { status: "submitting", message: `Sending to ${provider.label}`, error: undefined, progress: 0 });
            this.deps.log.info(`Job ${job.id}: submitting "${job.name}" to ${provider.label} (${image.byteLength} bytes)`);
            const res = await provider.submit(this.deps.context(), { image, width: input.width ?? 0, height: input.height ?? 0, hasAlpha: !!input.hasAlpha, name: job.name });
            this.patch(job, {
                remoteId: res.remoteId,
                status: "running",
                message: `Submitted to ${provider.label}`,
                meta: { ...job.meta, ...res.meta, failedStage: undefined },
                nextPollAt: this.now() + MIN_DELAY,
                pollDelayMs: MIN_DELAY,
                pollErrors: 0,
            });
            this.deps.log.info(`Job ${job.id}: ${provider.label} task ${res.remoteId}`);
            await this.deps.history.record({ providerId: job.providerId, remoteId: res.remoteId, name: job.name, createdAt: job.createdAt, meta: res.meta });
        } catch (err) {
            this.fail(job, err, "submit");
        } finally {
            this.busy.delete(job.id);
            this.ensureTimer();
        }
    }

    /** Polls every job that is due. Called by the timer; public for tests. */
    async tick(): Promise<void> {
        const now = this.now();
        const due = this.jobs.filter((j) => (j.status === "running" || j.status === "queued") && j.remoteId && !this.busy.has(j.id) && (j.nextPollAt ?? 0) <= now);
        const slots = MAX_CONCURRENT_POLLS - this.busy.size;
        await Promise.all(due.slice(0, Math.max(0, slots)).map((j) => this.pollJob(j)));
        if (!this.jobs.some(isActive) && this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async pollJob(job: Job) {
        this.busy.add(job.id);
        const provider = this.deps.provider(job.providerId);
        try {
            const res = await provider.poll(this.deps.context(), job.remoteId!, job.meta);
            const meta = res.meta ? { ...job.meta, ...res.meta } : job.meta;
            if (res.state === "succeeded" && res.result) {
                this.patch(job, { meta, progress: 100 });
                await this.download(job, res.result);
                return;
            }
            if (res.state === "failed") return this.fail(job, new Error(res.error ?? `${provider.label} reported a failure.`), "remote");
            if (res.state === "cancelled") {
                this.patch(job, { status: "cancelled", message: res.error ?? "Cancelled", meta });
                return;
            }
            const progress = res.progress ?? job.progress;
            const advanced = progress !== job.progress || res.message !== job.message;
            const delay = advanced ? MIN_DELAY : Math.min(MAX_DELAY, Math.round((job.pollDelayMs ?? MIN_DELAY) * 1.5));
            this.patch(job, { status: res.state, progress, message: res.message, meta, pollErrors: 0, pollDelayMs: delay, nextPollAt: this.now() + delay });
        } catch (err) {
            const errors = (job.pollErrors ?? 0) + 1;
            if (!isTransient(err) || errors >= MAX_POLL_ERRORS) return this.fail(job, err, "poll");
            const delay = Math.min(60_000, (job.pollDelayMs ?? MIN_DELAY) * 2);
            this.deps.log.warn(`Job ${job.id}: poll error ${errors}/${MAX_POLL_ERRORS}, retrying in ${delay} ms`, (err as Error).message);
            this.patch(job, { pollErrors: errors, pollDelayMs: delay, nextPollAt: this.now() + delay, message: `Connection problem, retrying (${errors}/${MAX_POLL_ERRORS})` });
        } finally {
            this.busy.delete(job.id);
        }
    }

    private async download(job: Job, result: ModelResult) {
        this.patch(job, { status: "downloading", message: "Downloading model" });
        try {
            const source = (await this.deps.store.readBytes(joinPath(JOBS_DIR, job.id, "source.png"))) ?? undefined;
            const item = await importModelResult(this.deps.fetch, this.deps.library, this.deps.log, result, {
                origin: job.providerId,
                remoteId: job.remoteId,
                name: job.name,
                source,
                onProgress: (message) => this.patch(job, { message }),
            });
            this.patch(job, { status: "succeeded", progress: 100, message: "Ready in library", libraryId: item.id, error: undefined });
            await this.deps.store.remove(joinPath(JOBS_DIR, job.id));
            this.deps.log.info(`Job ${job.id}: done → library ${item.id}`);
        } catch (err) {
            this.fail(job, err, "download");
        }
    }

    private fail(job: Job, err: unknown, stage: "submit" | "poll" | "remote" | "download") {
        const message = (err as Error)?.message ?? String(err);
        this.deps.log.error(`Job ${job.id} failed during ${stage}`, message);
        this.patch(job, { status: "failed", error: message, message: undefined, meta: { ...job.meta, failedStage: stage } });
    }

    /* -------------------------------------------------------------- actions */

    async cancel(id: string): Promise<Job> {
        const job = this.mustGet(id);
        if (!isActive(job)) return job;
        const provider = this.deps.provider(job.providerId);
        if (job.remoteId && provider.cancel) {
            try {
                await provider.cancel(this.deps.context(), job.remoteId, job.meta);
            } catch (err) {
                // Stop tracking anyway; tell the user the remote task may still run.
                this.patch(job, { status: "cancelled", message: (err as Error).message });
                return job;
            }
        }
        this.patch(job, {
            status: "cancelled",
            message: job.remoteId && !provider.cancel ? `${provider.label} has no cancel API; the task may still finish there (see Browse).` : "Cancelled",
        });
        return job;
    }

    async retry(id: string): Promise<Job> {
        const job = this.mustGet(id);
        if (isActive(job)) return job;
        const stage = job.meta?.failedStage;
        const provider = this.deps.provider(job.providerId);
        if (job.remoteId && (stage === "download" || stage === "poll")) {
            // The provider finished (or we lost contact): fetch fresh links and download again.
            this.patch(job, { status: "running", error: undefined, message: "Checking again", nextPollAt: this.now(), pollDelayMs: MIN_DELAY, pollErrors: 0 });
            if (stage === "download") {
                void (async () => {
                    try {
                        const result = await provider.resolve(this.deps.context(), job.remoteId!, job.meta);
                        await this.download(job, result);
                    } catch (err) {
                        this.fail(job, err, "download");
                    }
                })();
            }
            this.ensureTimer();
            return job;
        }
        this.patch(job, { remoteId: undefined, status: "queued", error: undefined, progress: 0, message: "Retrying" });
        void this.submit(job);
        return job;
    }

    /** Tracks an existing provider task by id (e.g. one started elsewhere). */
    async recover(providerId: ProviderId, remoteId: string, name?: string): Promise<Job> {
        const existing = this.jobs.find((j) => j.providerId === providerId && j.remoteId === remoteId && isActive(j));
        if (existing) return existing;
        const job: Job = {
            id: newId("job"),
            providerId,
            remoteId: remoteId.trim(),
            name: name?.trim() || `${this.deps.provider(providerId).label} task ${remoteId.slice(0, 8)}`,
            status: "running",
            progress: 0,
            message: "Looking up task",
            createdAt: this.now(),
            updatedAt: this.now(),
            nextPollAt: this.now(),
            pollDelayMs: MIN_DELAY,
            pollErrors: 0,
        };
        this.jobs.push(job);
        this.changed();
        await this.deps.history.record({ providerId, remoteId: job.remoteId!, name: job.name, createdAt: job.createdAt });
        this.ensureTimer();
        return job;
    }

    async dismiss(id: string): Promise<void> {
        const job = this.get(id);
        if (!job) return;
        if (isActive(job)) throw new Error("Cancel the job before removing it.");
        this.jobs = this.jobs.filter((j) => j.id !== id);
        await this.deps.store.remove(joinPath(JOBS_DIR, id));
        this.changed();
    }

    /* ------------------------------------------------------------- plumbing */

    private mustGet(id: string): Job {
        const job = this.get(id);
        if (!job) throw new Error("That job no longer exists.");
        return job;
    }

    private patch(job: Job, patch: Partial<Job>) {
        Object.assign(job, patch, { updatedAt: this.now() });
        for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (job as Record<string, unknown>)[k];
        this.changed();
    }

    private trim() {
        const finished = this.jobs.filter((j) => !isActive(j)).sort((a, b) => b.createdAt - a.createdAt);
        const drop = new Set(finished.slice(KEEP_FINISHED).map((j) => j.id));
        if (drop.size) this.jobs = this.jobs.filter((j) => !drop.has(j.id));
    }

    private changed() {
        const snapshot = this.list();
        for (const fn of this.listeners) fn(snapshot);
        this.persistSoon();
    }

    private persistSoon() {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void writeJson(this.deps.store, JOBS_FILE, { jobs: this.jobs }).catch((err) => this.deps.log.error("Could not save jobs.json", err));
        }, 250);
    }

    /** Writes jobs.json now (tests, shutdown). */
    async flush(): Promise<void> {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = null;
        await writeJson(this.deps.store, JOBS_FILE, { jobs: this.jobs });
    }

    private ensureTimer() {
        const tickMs = this.deps.tickMs ?? 1000;
        if (tickMs <= 0 || this.timer || !this.jobs.some(isActive)) return;
        this.timer = setInterval(() => void this.tick(), tickMs);
    }
}
