/**
 * Host side of the WebView bridge (see src/shared/protocol.ts).
 *
 * One BridgeServer per <webview>. Requests are dispatched to `handlers`; every call
 * is logged with its duration, and errors go back to the page as messages instead
 * of being swallowed.
 */
import { isBridgeMessage, type EventMessage, type HostApi, type HostEventName, type HostEvents, type HostMethod, type RequestMessage, type ResponseMessage } from "@shared/protocol";
import type { Logger } from "../platform/logger";

export type Handlers = { [M in HostMethod]?: (params: HostApi[M][0], meta: { source: string }) => Promise<HostApi[M][1]> | HostApi[M][1] };

/** Methods whose params are too big or too sensitive to log. */
const QUIET_PARAMS = new Set<HostMethod>(["settings.setSecret", "library.saveThumbnail", "library.addConverted", "library.addModel", "editor.complete", "log.write"]);
// library.scanInbox runs every few seconds while the Library tab is open; the importer logs what it finds.
const QUIET_CALLS = new Set<HostMethod>(["log.write", "ps.context", "jobs.list", "log.tail", "library.scanInbox"]);
/** Methods whose failures are normal states shown in the UI ("Layer is empty"), logged at debug level. */
const EXPECTED_FAILURES = new Set<HostMethod>(["ps.sourcePreview"]);

export interface MessageTarget {
    postMessage(message: unknown): void;
}

export class BridgeServer {
    private alive = true;

    constructor(
        readonly name: string,
        private readonly target: MessageTarget,
        private readonly handlers: Handlers,
        private readonly log: Logger,
    ) {}

    /** Feed every `message` event of this webview here. */
    async handle(raw: unknown): Promise<void> {
        let data = raw;
        if (typeof data === "string") {
            try {
                data = JSON.parse(data);
            } catch {
                return;
            }
        }
        if (!isBridgeMessage(data) || data.t !== "req") return;
        const req = data as RequestMessage;
        const handler = this.handlers[req.method] as ((p: unknown, m: { source: string }) => Promise<unknown>) | undefined;
        const started = Date.now();
        let response: ResponseMessage;
        try {
            if (!handler) throw new Error(`Unknown bridge method: ${req.method}`);
            const result = await handler(req.params, { source: this.name });
            response = { t: "res", id: req.id, ok: true, result: result ?? null };
            if (!QUIET_CALLS.has(req.method)) this.log.debug(`[${this.name}] ${req.method} ok in ${Date.now() - started} ms`, QUIET_PARAMS.has(req.method) ? undefined : req.params);
        } catch (err) {
            const message = (err as Error)?.message ?? String(err);
            this.log[EXPECTED_FAILURES.has(req.method) ? "debug" : "warn"](`[${this.name}] ${req.method} failed: ${message}`, QUIET_PARAMS.has(req.method) ? undefined : req.params);
            response = { t: "res", id: req.id, ok: false, error: { message } };
        }
        this.send(response);
    }

    emit<E extends HostEventName>(name: E, data: HostEvents[E]): void {
        this.send({ t: "evt", name, data } satisfies EventMessage);
    }

    private send(message: unknown) {
        if (!this.alive) return;
        try {
            this.target.postMessage(message);
        } catch (err) {
            this.log.warn(`[${this.name}] postMessage failed`, (err as Error).message);
        }
    }

    close() {
        this.alive = false;
    }
}
