/**
 * All 3D services the plugin knows. To add one, implement ProviderAdapter in a new
 * file (see meshy.ts for a complete example) and list it here; the panel, job queue,
 * browse view and settings pick it up from ProviderStatus.
 */
import type { ProviderId } from "@shared/types";
import { comfyui } from "./comfyui";
import { hitem3d } from "./hitem3d";
import { meshy } from "./meshy";
import { tripo } from "./tripo";
import type { ProviderAdapter } from "./types";

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = { meshy, tripo, hitem3d, comfyui };

export function getProvider(id: ProviderId): ProviderAdapter {
    const p = PROVIDERS[id];
    if (!p) throw new Error(`Unknown 3D service: ${id}`);
    return p;
}
