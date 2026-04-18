// Asset catalog — JSON produced by the plugin's AssetCatalog.HarvestScene on each canvas
// the player visits. The editor reads it so authors can pick existing in-game assets
// (trees, rocks, palms, etc.) and drop them on their map via `spawnAsset` ops.
//
// The catalog grows over time as you play more canvases. This module holds the most recently
// loaded catalog, persists it through localStorage so a refresh keeps the palette alive, and
// notifies subscribers when entries change.

const STORAGE_KEY = "sbg-map-editor:asset-catalog";

let catalog = { schema: 1, assets: [] };
const listeners = new Set();

(function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) catalog = JSON.parse(raw) ?? catalog;
  } catch {
    // corrupt stash — ignore
  }
})();

export function getCatalog() { return catalog; }
export function getAssets() { return catalog.assets || []; }
export function getCanvases() { return catalog.canvases || []; }
export function findAsset(id) { return (catalog.assets || []).find((a) => a.id === id) || null; }

// Return { teeLocal, holeLocal } in editor coords (tee at origin) for the given canvas
// key. The catalog keys entries by the Unity scene name (e.g. "Twin Beach") but the editor
// uses user-friendly "Course/HoleName" (e.g. "Coast/TwinBeach"). We loose-match the final
// segment against scene names, inserting spaces between camel-case runs as needed.
export function getCanvasGhost(canvasKey) {
  if (!canvasKey) return null;
  const want = normalizeKey(canvasKey.includes("/") ? canvasKey.split("/")[1] : canvasKey);
  const c = (catalog.canvases || []).find((x) => normalizeKey(x.scene) === want);
  if (!c) return null;
  const sub = (a, b) => a && b ? [a[0] - b[0], a[1] - b[1], a[2] - b[2]] : null;
  return {
    teeLocal: c.tee ? [0, 0, 0] : null,
    holeLocal: sub(c.hole, c.tee),
  };
}
function normalizeKey(s) {
  return (s || "").toLowerCase().replace(/[\s_-]+/g, "");
}

export function subscribeCatalog(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Replace the whole catalog. Persists to localStorage and notifies subscribers.
export function setCatalog(next) {
  catalog = (next && typeof next === "object" && Array.isArray(next.assets))
    ? next
    : { schema: 1, assets: [] };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(catalog)); } catch {}
  for (const fn of listeners) fn();
}

export async function loadCatalogFromFile(file) {
  if (!file) return { ok: false, error: "No file." };
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.assets)) throw new Error("Expected { assets: [...] } shape.");
    setCatalog(parsed);
    return { ok: true, count: parsed.assets.length };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export function clearCatalog() {
  setCatalog({ schema: 1, assets: [] });
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}
