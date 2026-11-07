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
// Token: keep the WHOLE picture. It is placed in the middle of a square (transparent space if the
// picture is not square), up to 512 x 512, never enlarged. WebP where the browser supports it, else PNG.
export async function prepareToken(file: File) {
  const img = await loadImage(file);
  const w0 = img.naturalWidth;
  const h0 = img.naturalHeight;
  if (!w0 || !h0) throw new Error("Unsupported image");
  const longest = Math.max(w0, h0);
  const side = Math.min(longest, 512);
  const scale = side / longest; // 1 or smaller
  const dw = Math.round(w0 * scale);
  const dh = Math.round(h0 * scale);
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process image");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (side - dw) / 2, (side - dh) / 2, dw, dh);
  return toBlob(canvas, "image/webp", 0.92);
}

// Returns an error message, or null when the upload worked
export async function upload(
  kind: "map" | "token" | "thumb",
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

// Small preview of a map picture that is already uploaded (about 240 px, a few KB)
export async function prepareThumb(url: string): Promise<Blob> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Could not load the map picture"));
    i.src = url;
  });
  const w0 = img.naturalWidth;
  const h0 = img.naturalHeight;
  if (!w0 || !h0) throw new Error("Unsupported image");
  const scale = Math.min(1, 240 / Math.max(w0, h0));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w0 * scale));
  canvas.height = Math.max(1, Math.round(h0 * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process image");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return toBlob(canvas, "image/jpeg", 0.7);
}