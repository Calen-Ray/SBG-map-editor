// Optional custom icon upload. If the user picks a PNG/JPEG, we normalise it to a 256×256
// PNG ArrayBuffer and stash it in-module. Export uses the custom bytes when present; the
// preview thumb in the top bar re-renders live.
//
// Persistence: icon lives only in memory + is carried in the autosave blob via localStorage
// (re-encoded as a data URL to fit JSON). A page reload restores it.

const AUTOSAVE_KEY = "sbg-map-editor:icon";
const SIZE = 256;

let customBytes = null;                                    // ArrayBuffer of the final 256x256 PNG
let customDataUrl = null;                                  // for UI preview + autosave round-trip
const changeListeners = new Set();

export function getCustomIconBytes() { return customBytes; }
export function getCustomIconDataUrl() { return customDataUrl; }
export function subscribeIcon(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); }
function emit() { for (const fn of changeListeners) fn(); }

// Load/encode a user-supplied image into the canonical 256x256 PNG the export uses.
export async function setCustomIconFromFile(file) {
  if (!file) { clearCustomIcon(); return; }
  if (!/^image\/(png|jpeg)$/.test(file.type)) throw new Error("Icon must be PNG or JPEG.");
  const bmp = await loadBitmap(file);
  const { bytes, dataUrl } = await normalise(bmp);
  customBytes = bytes;
  customDataUrl = dataUrl;
  persist();
  emit();
}

export function clearCustomIcon() {
  customBytes = null;
  customDataUrl = null;
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch {}
  emit();
}

// ── internals ─────────────────────────────────────────────────────────────

async function loadBitmap(file) {
  // createImageBitmap handles PNG/JPEG/WEBP without an IMG element; resize-hint keeps the
  // decoded buffer modest for large uploads.
  return await createImageBitmap(file, {
    resizeWidth: SIZE,
    resizeHeight: SIZE,
    resizeQuality: "high",
  });
}

async function normalise(bmp) {
  const c = document.createElement("canvas");
  c.width = SIZE; c.height = SIZE;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#1b1f24";
  ctx.fillRect(0, 0, SIZE, SIZE);
  // Cover-fit: fill the square with the uploaded image, crop overflow.
  const srcAspect = bmp.width / bmp.height;
  let sw, sh, sx, sy;
  if (srcAspect > 1) {
    sh = bmp.height; sw = bmp.height; sx = (bmp.width - sw) / 2; sy = 0;
  } else {
    sw = bmp.width; sh = bmp.width; sx = 0; sy = (bmp.height - sh) / 2;
  }
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, SIZE, SIZE);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const bytes = await blob.arrayBuffer();
  const dataUrl = c.toDataURL("image/png");
  return { bytes, dataUrl };
}

function persist() {
  if (!customDataUrl) return;
  try { localStorage.setItem(AUTOSAVE_KEY, customDataUrl); } catch {}
}

// Restore on module load. Fire-and-forget; listeners that care (icon-chip preview) will see
// the change the moment this resolves.
(async function restore() {
  try {
    const saved = localStorage.getItem(AUTOSAVE_KEY);
    if (!saved) return;
    const res = await fetch(saved);
    const blob = await res.blob();
    customBytes = await blob.arrayBuffer();
    customDataUrl = saved;
    emit();
  } catch {
    // Corrupt stash — ignore and leave icon empty.
  }
})();
