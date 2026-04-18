// Load a .mapjson (or a .zip containing one) back into the editor. Pairs with export.js
// so round-tripping works: export, edit, re-export.

import { SCHEMA_VERSION, CANVASES, OPS } from "./schema.js";
import { replaceState } from "./state.js";
import JSZip from "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";

// Public: accept a File (user-picked or drag-dropped), auto-detect by name, hydrate state.
// Returns { ok: boolean, error?: string } — caller shows it in the validation panel.
export async function importFile(file) {
  if (!file) return { ok: false, error: "No file." };
  try {
    const name = (file.name || "").toLowerCase();
    let mapjsonText;
    if (name.endsWith(".mapjson") || name.endsWith(".json")) {
      mapjsonText = await file.text();
    } else if (name.endsWith(".zip")) {
      mapjsonText = await extractMapjsonFromZip(file);
      if (!mapjsonText) return { ok: false, error: "Zip contains no Maps/*/*.mapjson." };
    } else {
      return { ok: false, error: `Unsupported file: ${file.name}. Drop a .mapjson or .zip.` };
    }

    const data = JSON.parse(mapjsonText);
    const next = hydrate(data);
    replaceState(next, { resetUids: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function extractMapjsonFromZip(file) {
  const zip = await JSZip.loadAsync(file);
  // Pick the first file whose name ends in .mapjson under any Maps/<id>/ path.
  for (const name of Object.keys(zip.files)) {
    if (name.endsWith(".mapjson")) return await zip.files[name].async("string");
  }
  return null;
}

// Normalise an externally-loaded .mapjson into editor-state shape. Missing fields default,
// unknown ops are dropped (with a warning recorded on the returned object — caller can log).
function hydrate(data) {
  if (!data || typeof data !== "object") throw new Error("Not a .mapjson object.");
  if (data.schema && data.schema > SCHEMA_VERSION) {
    throw new Error(`.mapjson is schema ${data.schema}; editor understands up to ${SCHEMA_VERSION}. Update the editor.`);
  }

  const canvasId = CANVASES.some((c) => c.id === data.canvas) ? data.canvas : CANVASES[0].id;
  const build = Array.isArray(data.build) ? data.build : [];

  return {
    id: asString(data.id, "my-first-map"),
    displayName: asString(data.displayName, "My First Map"),
    author: asString(data.author, ""),
    version: asString(data.version, "0.1.0"),
    par: Number.isFinite(data.par) ? data.par : 3,
    difficulty: ["Beginner", "Intermediate", "Expert"].includes(data.difficulty) ? data.difficulty : "Beginner",
    canvas: canvasId,
    description: asString(data.description, ""),
    cleanCanvas: data.cleanCanvas === true,
    build: ensureSingletons(build
      .filter((b) => b && OPS[b.op])
      .map((b) => {
        const spec = OPS[b.op];
        const item = { uid: "", op: b.op, pos: toVec(b.pos, spec.defaults.pos) };
        if (spec.defaults.scale) item.scale = toVec(b.scale, spec.defaults.scale);
        if (typeof spec.defaults.rotY === "number") {
          item.rotY = Number.isFinite(b.rotY) ? b.rotY : spec.defaults.rotY;
        }
        if (typeof spec.defaults.terrainLayer === "string") {
          item.terrainLayer = typeof b.terrainLayer === "string" ? b.terrainLayer : spec.defaults.terrainLayer;
        }
        if (typeof spec.defaults.assetId === "string") {
          item.assetId = typeof b.assetId === "string" ? b.assetId : spec.defaults.assetId;
        }
        return item;
      })),
  };
}

// Every editor session needs exactly one canvas tee and one canvas hole — palette filters
// singletons so a user importing a malformed .mapjson can't re-add them from the UI.
function ensureSingletons(list) {
  const have = new Set(list.map((b) => b.op));
  if (!have.has("moveTee"))  list.unshift({ uid: "", op: "moveTee",  pos: [...OPS.moveTee.defaults.pos] });
  if (!have.has("moveHole")) list.unshift({ uid: "", op: "moveHole", pos: [...OPS.moveHole.defaults.pos] });
  return list;
}

function asString(v, fallback) { return typeof v === "string" ? v : fallback; }
function toVec(v, fallback) {
  if (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((n) => Number.isFinite(n))) {
    return [v[0], v[1], v[2]];
  }
  return [...fallback];
}
