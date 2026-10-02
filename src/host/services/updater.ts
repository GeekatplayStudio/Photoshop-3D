/**
 * Update check against GitHub releases, and one-click install.
 *
 * Check:   GET https://api.github.com/repos/<repo>/releases/latest (or the release list when
 *          pre-releases are enabled). A release is "available" when its tag (vX.Y.Z) is newer
 *          than this plugin and it has a .ccx asset. Automatic checks run at most every
 *          `checkIntervalHours`; the panel can force one.
 * Install: download the .ccx, verify it against SHA256SUMS.txt from the same release, save it
 *          to the plugin temp folder and open it. Creative Cloud's installer (UPIA) asks the user
 *          to confirm, installs it, and Photoshop reloads the plugin — settings, keys and the
 *          library live in the data folder and are kept.
 */
import { compareVersions, isPrerelease } from "@shared/semver";
import { utf8Decode } from "@shared/bytes";
import { parseChecksums, sha256Hex } from "@shared/sha256";
import type { UpdateInfo } from "@shared/types";
import { downloadBytes, requestJson, type FetchLike } from "../platform/http";
import type { Logger } from "../platform/logger";
import type { SettingsService } from "./settingsService";

type GhAsset = { name: string; browser_download_url: string; size: number };
type GhRelease = { tag_name: string; name?: string; body?: string; html_url: string; draft: boolean; prerelease: boolean; published_at?: string; assets: GhAsset[] };

export type UpdaterDeps = {
    fetch: FetchLike;
    log: Logger;
    settings: SettingsService;
    currentVersion: string;
    /** Writes the installer to a temp file and returns its native path. */
    saveTemp(name: string, bytes: Uint8Array): Promise<string>;
    /** Opens a file with the OS handler (Creative Cloud for .ccx). */
    openPath(path: string): Promise<void>;
    now?: () => number;
};

const API = "https://api.github.com";

/** Picks the newest usable release from GitHub's list. */
export function pickRelease(releases: GhRelease[], includePrerelease: boolean): GhRelease | undefined {
    return releases
        .filter((r) => !r.draft && (includePrerelease || !r.prerelease) && r.assets.some((a) => a.name.toLowerCase().endsWith(".ccx")))
        .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
}

export class Updater {
    private last: UpdateInfo | null = null;
    private release: GhRelease | null = null;

    constructor(private readonly deps: UpdaterDeps) {}

    private now() {
        return this.deps.now?.() ?? Date.now();
    }

    get lastInfo(): UpdateInfo | null {
        return this.last;
    }

    /** True when an automatic check is due. */
    isDue(): boolean {
        const u = this.deps.settings.value.updates;
        return u.autoCheck && this.now() - u.lastCheckAt > u.checkIntervalHours * 3600_000;
    }

    async check(): Promise<UpdateInfo> {
        const { repo, includePrerelease } = this.deps.settings.value.updates;
        const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
        const info: UpdateInfo = { currentVersion: this.deps.currentVersion, available: false, checkedAt: this.now() };
        try {
            let releases: GhRelease[];
            if (includePrerelease) {
                releases = await requestJson<GhRelease[]>(this.deps.fetch, `${API}/repos/${repo}/releases?per_page=20`, { headers, label: "GitHub", timeoutMs: 20_000 }, this.deps.log);
            } else {
                try {
                    releases = [await requestJson<GhRelease>(this.deps.fetch, `${API}/repos/${repo}/releases/latest`, { headers, label: "GitHub", timeoutMs: 20_000 }, this.deps.log)];
                } catch (err) {
                    if ((err as { status?: number }).status === 404) releases = []; // no release published yet
                    else throw err;
                }
            }
            const release = pickRelease(releases, includePrerelease);
            this.release = release ?? null;
            if (release) {
                const asset = release.assets.find((a) => a.name.toLowerCase().endsWith(".ccx"))!;
                Object.assign(info, {
                    latestVersion: release.tag_name.replace(/^v/, ""),
                    releaseName: release.name || release.tag_name,
                    releaseNotes: (release.body ?? "").slice(0, 4000),
                    releaseUrl: release.html_url,
                    downloadUrl: asset.browser_download_url,
                    publishedAt: release.published_at,
                    available: compareVersions(release.tag_name, this.deps.currentVersion) > 0 && (includePrerelease || !isPrerelease(release.tag_name)),
                });
            }
            this.deps.log.info(`Update check: current ${info.currentVersion}, latest ${info.latestVersion ?? "none"}${info.available ? " — update available" : ""}`);
        } catch (err) {
            info.error = (err as Error).message;
            this.deps.log.warn("Update check failed", info.error);
        }
        await this.deps.settings.updateQuietly({ updates: { lastCheckAt: info.checkedAt } });
        this.last = info;
        return info;
    }

    async install(): Promise<{ started: boolean; message: string }> {
        if (!this.release || !this.last?.available) await this.check();
        const release = this.release;
        if (!release || !this.last?.available) return { started: false, message: "You already have the latest version." };
        const asset = release.assets.find((a) => a.name.toLowerCase().endsWith(".ccx"))!;
        this.deps.log.info(`Downloading update ${release.tag_name} (${asset.name})`);
        const bytes = await downloadBytes(this.deps.fetch, asset.browser_download_url, { label: "Update download", maxBytes: 300 * 1024 * 1024 }, this.deps.log);

        const sums = release.assets.find((a) => /^sha256sums(\.txt)?$/i.test(a.name));
        if (sums) {
            const text = utf8Decode(await downloadBytes(this.deps.fetch, sums.browser_download_url, { label: "Checksum download", maxBytes: 1024 * 1024 }, this.deps.log));
            const expected = parseChecksums(text).get(asset.name);
            const actual = sha256Hex(bytes);
            if (!expected) throw new Error(`SHA256SUMS.txt has no entry for ${asset.name}; not installing.`);
            if (expected !== actual) throw new Error(`The download is corrupted (SHA-256 ${actual.slice(0, 12)}… ≠ ${expected.slice(0, 12)}…). Try again.`);
            this.deps.log.info(`Update ${asset.name} verified (SHA-256 ${actual})`);
        } else {
            this.deps.log.warn(`Release ${release.tag_name} has no SHA256SUMS.txt; installing without checksum verification`);
        }

        const path = await this.deps.saveTemp(asset.name, bytes);
        await this.deps.openPath(path);
        this.deps.log.info(`Opened ${path} with Creative Cloud`);
        return {
            started: true,
            message: `Creative Cloud is installing ${release.tag_name}. Confirm the prompt if one appears; Photoshop reloads the plugin when it is done.`,
        };
    }
}
