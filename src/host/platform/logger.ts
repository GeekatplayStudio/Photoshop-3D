/**
 * The plugin log: <data folder>/logs/photoshop3d.log.
 *
 * Every provider call, job transition, Photoshop operation and error is written
 * here (and to the UXP console) so nothing the plugin does is a black box. The
 * file is rewritten from an in-memory buffer at most every second, capped at
 * ~512 KB, with the previous file kept as photoshop3d.1.log. API keys are never
 * logged: `redact` masks anything that looks like a credential.
 */
import type { FileStore } from "./fileStore";
import type { LogLevel } from "@shared/protocol";

export const LOG_FILE = "logs/photoshop3d.log";
const ROTATED_FILE = "logs/photoshop3d.1.log";
const MAX_BYTES = 512 * 1024;

export interface Logger {
    debug(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
    tail(lines: number): string;
    flush(): Promise<void>;
}

const SECRET_PATTERNS: RegExp[] = [
    /(authorization["']?\s*[:=]\s*["']?)(bearer\s+|basic\s+)?[^"',\s}]+/gi,
    /\b(msy_|tsk_|sk-)[A-Za-z0-9_-]{6,}/g,
    /("(?:api_?key|apiKey|secret|secretKey|accessKey|token|access_token|accessToken)"\s*:\s*")[^"]+/gi,
];

/** Masks credentials in log text. */
export function redact(text: string): string {
    let out = text;
    out = out.replace(SECRET_PATTERNS[0], (_m, p1: string, p2: string | undefined) => `${p1}${p2 ?? ""}***`);
    out = out.replace(SECRET_PATTERNS[1], (_m, p1: string) => `${p1}***`);
    out = out.replace(SECRET_PATTERNS[2], (_m, p1: string) => `${p1}***`);
    return out;
}

function stringify(data: unknown): string {
    if (data === undefined) return "";
    if (data instanceof Error) return ` ${data.message}${data.stack ? `\n${data.stack}` : ""}`;
    try {
        const s = typeof data === "string" ? data : JSON.stringify(data);
        return ` ${s.length > 4000 ? `${s.slice(0, 4000)}… (${s.length} chars)` : s}`;
    } catch {
        return ` ${String(data)}`;
    }
}

export class FileLogger implements Logger {
    private lines: string[] = [];
    private bytes = 0;
    private dirty = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private writing: Promise<void> = Promise.resolve();

    constructor(
        private readonly store: FileStore | null,
        private readonly minLevel: LogLevel = "debug",
        private readonly consoleOut: Pick<Console, "log" | "warn" | "error"> | null = typeof console !== "undefined" ? console : null,
    ) {}

    /** Loads the existing log so a reload keeps appending to it. */
    async init(): Promise<void> {
        if (!this.store) return;
        const existing = await this.store.readText(LOG_FILE).catch(() => null);
        if (existing) {
            this.lines = existing.split("\n").filter(Boolean);
            this.bytes = existing.length;
        }
    }

    private write(level: LogLevel, message: string, data?: unknown) {
        const order: LogLevel[] = ["debug", "info", "warn", "error"];
        if (order.indexOf(level) < order.indexOf(this.minLevel)) return;
        const line = redact(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${stringify(data)}`);
        this.consoleOut?.[level === "error" ? "error" : level === "warn" ? "warn" : "log"](line);
        this.lines.push(line);
        this.bytes += line.length + 1;
        this.dirty = true;
        this.schedule();
    }

    private schedule() {
        if (!this.store || this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, 1000);
    }

    async flush(): Promise<void> {
        if (!this.store || !this.dirty) return this.writing;
        this.dirty = false;
        this.writing = this.writing.then(async () => {
            try {
                if (this.bytes > MAX_BYTES) {
                    const half = Math.floor(this.lines.length / 2);
                    await this.store!.writeText(ROTATED_FILE, this.lines.slice(0, half).join("\n") + "\n");
                    this.lines = this.lines.slice(half);
                    this.bytes = this.lines.reduce((n, l) => n + l.length + 1, 0);
                }
                await this.store!.writeText(LOG_FILE, this.lines.join("\n") + "\n");
            } catch (err) {
                this.consoleOut?.error("Could not write the log file", err);
            }
        });
        return this.writing;
    }

    tail(lines: number): string {
        return this.lines.slice(-Math.max(1, lines)).join("\n");
    }

    debug(m: string, d?: unknown) {
        this.write("debug", m, d);
    }
    info(m: string, d?: unknown) {
        this.write("info", m, d);
    }
    warn(m: string, d?: unknown) {
        this.write("warn", m, d);
    }
    error(m: string, d?: unknown) {
        this.write("error", m, d);
    }
}

/** A logger that only collects lines in memory (tests). */
export class MemoryLogger implements Logger {
    readonly lines: string[] = [];
    private push(level: string, m: string, d?: unknown) {
        this.lines.push(redact(`${level} ${m}${stringify(d)}`));
    }
    debug(m: string, d?: unknown) {
        this.push("debug", m, d);
    }
    info(m: string, d?: unknown) {
        this.push("info", m, d);
    }
    warn(m: string, d?: unknown) {
        this.push("warn", m, d);
    }
    error(m: string, d?: unknown) {
        this.push("error", m, d);
    }
    tail(n: number) {
        return this.lines.slice(-n).join("\n");
    }
    async flush() {}
}
