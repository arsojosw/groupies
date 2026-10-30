import { getSession } from "./socket";

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read this image. Use a PNG, JPG or WebP file."));
    };
    img.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not process image"))), type, quality)
  );
}

// Map: shrink so the longest side is at most 3000 px, save as JPEG
export async function prepareMap(file: File) {
  const img = await loadImage(file);
  const w0 = img.naturalWidth;
  const h0 = img.naturalHeight;
  if (!w0 || !h0) throw new Error("Unsupported image");
  const scale = Math.min(1, 3000 / Math.max(w0, h0));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w0 * scale));
  canvas.height = Math.max(1, Math.round(h0 * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process image");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { blob: await toBlob(canvas, "image/jpeg", 0.85), width: w0, height: h0 };
}

// Token: crop the middle square and keep up to 512 x 512 (never enlarged).
// Saved as WebP where the browser supports it, otherwise PNG.
export async function prepareToken(file: File) {
  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) throw new Error("Unsupported image");
  const out = Math.min(side, 512);
  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process image");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
  return toBlob(canvas, "image/webp", 0.92);
}

// Returns an error message, or null when the upload worked
export async function upload(
  kind: "map" | "token",
  blob: Blob,
  params: Record<string, string | number>
): Promise<string | null> {
  const qs = new URLSearchParams({ kind, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  try {
    const res = await fetch(`/api/upload?${qs}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getSession()}`, "Content-Type": blob.type },
      body: blob,
    });
    if (res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return data.error ?? `Upload failed (${res.status})`;
  } catch {
    return "Upload failed. Check your connection.";
  }
}