/**
 * Web APIs missing from Photoshop's UXP host JavaScript (UXP 9.4): TextEncoder and
 * TextDecoder (UTF-8 only). Imported first by main.ts so every module — and libraries
 * such as fflate — can rely on them.
 */
import { decodeUtf8, encodeUtf8 } from "@shared/utf8";

const g = globalThis as unknown as Record<string, unknown>;

if (typeof g.TextEncoder === "undefined") {
    g.TextEncoder = class TextEncoder {
        readonly encoding = "utf-8";
        encode(input = ""): Uint8Array {
            return encodeUtf8(String(input));
        }
    };
}

if (typeof g.TextDecoder === "undefined") {
    g.TextDecoder = class TextDecoder {
        readonly encoding = "utf-8";
        constructor(label = "utf-8") {
            if (!/^utf-?8$/i.test(label)) throw new Error(`TextDecoder polyfill only supports UTF-8, not ${label}`);
        }
        decode(input?: ArrayBuffer | ArrayBufferView): string {
            if (!input) return "";
            const bytes = input instanceof Uint8Array ? input : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
            return decodeUtf8(bytes);
        }
    };
}
