import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createWorker, OEM, PSM } from "tesseract.js";

const require = createRequire(import.meta.url);
const langPath = join(dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
const maxImageBytes = 2 * 1024 * 1024;
let worker;

function imageSize(bytes, format) {
  if (format === "png" && bytes.length >= 24 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (format !== "jpeg" || bytes.length < 4 || bytes.readUInt16BE() !== 0xffd8) return [];
  const frameMarkers = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];
  for (let offset = 2; offset + 4 < bytes.length;) {
    if (bytes[offset++] !== 0xff) return [];
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) return [];
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return [];
    if (frameMarkers.includes(marker) && length >= 7) {
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  return [];
}

export function decodeOdometerPhoto(value) {
  if (typeof value !== "string" || value.length > Math.ceil(maxImageBytes * 4 / 3) + 32) return null;
  const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[2], "base64");
  const [width, height] = imageSize(bytes, match[1]);
  if (!width || !height || width > 2000 || height > 2000 || bytes.length > maxImageBytes) return null;
  return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
}

export async function readOdometerPhoto(bytes, expected) {
  worker ||= await createWorker("eng", OEM.LSTM_ONLY, { langPath, cacheMethod: "none" });
  await worker.setParameters({
    tessedit_char_whitelist: "0123456789",
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
  });
  const { data: { text, confidence } } = await worker.recognize(bytes);
  const readings = text.match(/\d+/g) || [];
  return {
    matched: confidence >= 35 && readings.some((reading) => Number(reading) === expected),
    text: text.trim(),
    confidence: Math.round(confidence),
  };
}
