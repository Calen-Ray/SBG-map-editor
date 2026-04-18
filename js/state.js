// Single source of truth for the edited map. Subscribers (view, inspector, palette, export)
// re-render whenever mutations fire the change callback.

import { OPS, SCHEMA_VERSION, CANVASES } from "./schema.js";

const AUTOSAVE_KEY = "sbg-map-editor:autosave";
const AUTOSAVE_DEBOUNCE_MS = 250;

let nextId = 1;
const newId = (prefix) => `${prefix}-${nextId++}`;

function makeInitialMap() {
  return {
    // Metadata (populated into manifest.json + .mapjson at export)
    // id/author must be alphanumeric + underscore only — see validation.js for why.
    id: "my_first_map",
    displayName: "My First Map",
    author: "",
    version: "0.1.0",
    par: 3,
    difficulty: "Beginner",
    canvas: CANVASES[0].id,
    description: "",
    cleanCanvas: false,

    // Build ops — each has a UI-only `uid` for selection that's stripped on export.
    build: [
      { uid: newId("tee"),  op: "moveTee",  pos: [0, 0, 0] },
      { uid: newId("hole"), op: "moveHole", pos: [0, 0, 8] },
    ],
  };
}

const listeners = new Set();
let state = loadFromStorage() ?? makeInitialMap();
let selectedUids = new Set();   // multi-select: empty Set = nothing selected

// ── Undo / redo ────────────────────────────────────────────────────────────
// Snapshot-based history. Snapshots are deep clones of `state`; selection is intentionally
// NOT included — after an undo the restored state may or may not contain the previously-
// selected uids, and preserving selection through structural changes is more confusing
// than helpful.
//
// Coalescing: consecutive mutations within HISTORY_COALESCE_MS are treated as one undo
// step. This keeps a drag (which fires dozens of `translateSelected` calls a second) or
// a typing burst from flooding the history.
const HISTORY_COALESCE_MS = 300;
const MAX_HISTORY = 100;
const past = [];
const future = [];
let lastCommitAt = 0;

function snapshot() { return JSON.parse(JSON.stringify(state)); }

// Call BEFORE a mutation. Pushes the pre-mutation state to `past` unless the previous
// push is fresh enough to absorb this change into the same undo step.
function beginMutation() {
  const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
  if (now - lastCommitAt > HISTORY_COALESCE_MS) {
    past.push(snapshot());
    if (past.length > MAX_HISTORY) past.shift();
    future.length = 0;
  }
  lastCommitAt = now;
}

export function canUndo() { return past.length > 0; }
export function canRedo() { return future.length > 0; }

export function undo() {
  if (past.length === 0) return;
  future.push(snapshot());
  state = past.pop();
  selectedUids = new Set();
  lastCommitAt = (typeof performance !== "undefined" ? performance.now() : Date.now());
  emit();
}
export function redo() {
  if (future.length === 0) return;
  past.push(snapshot());
  state = future.pop();
  selectedUids = new Set();
  lastCommitAt = (typeof performance !== "undefined" ? performance.now() : Date.now());
  emit();
}

export function getState() { return state; }
// Back-compat: getSelected / getSelectedUid return the "primary" (last added to selection).
export function getSelected() {
  const uid = lastOf(selectedUids);
  return uid ? (state.build.find((b) => b.uid === uid) ?? null) : null;
}
export function getSelectedUid() { return lastOf(selectedUids); }
export function getSelectedUids() { return [...selectedUids]; }
export function isSelected(uid) { return selectedUids.has(uid); }
function lastOf(set) {
  let last = null;
  for (const v of set) last = v;
  return last;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  for (const fn of listeners) fn();
  scheduleAutosave();
}

// ── Autosave ─────────────────────────────────────────────────────────────
// Persist to localStorage on mutations. Debounced so drag operations don't thrash.
// Restored on page load via loadFromStorage(). A failed read (quota, corrupt JSON,
// disabled storage) never throws — we just skip and start fresh.

let autosaveTimer = null;
function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(writeAutosave, AUTOSAVE_DEBOUNCE_MS);
}
function writeAutosave() {
  autosaveTimer = null;
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ schema: SCHEMA_VERSION, state, nextId }));
  } catch {
    // Storage full or disabled — not fatal.
  }
}
function loadFromStorage() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.schema !== SCHEMA_VERSION || !parsed.state?.build) return null;
    // Preserve the uid counter so newly-added items don't collide with restored ones.
    if (typeof parsed.nextId === "number") nextId = parsed.nextId;
    return parsed.state;
  } catch {
    return null;
  }
}

// Replace the entire state (used by Open / Import / Reset). Treated as an undoable action
// so users can undo an accidental Open / Reset.
export function replaceState(next, options = {}) {
  beginMutation();
  state = next;
  selectedUids = new Set();
  if (options.resetUids) {
    // Reassign uids so two imports in a row don't collide.
    nextId = 1;
    for (const b of state.build) b.uid = newId(b.op);
  }
  emit();
}

export function resetState() {
  // History is cleared so "undo after reset" doesn't travel back through the destroyed map.
  past.length = 0;
  future.length = 0;
  state = makeInitialMap();
  selectedUids = new Set();
  lastCommitAt = 0;
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch {}
  emit();
}

export function setMeta(key, value) {
  if (!(key in state)) return;
  if (state[key] === value) return; // ignore no-op edits (selector re-renders triggering input events)
  beginMutation();
  state[key] = value;
  emit();
}

// Exclusive selection. Pass null/undefined to clear.
export function setSelected(uid) {
  selectedUids = uid ? new Set([uid]) : new Set();
  emit();
}

// Shift-click behavior: toggle a uid in/out of the current selection.
export function toggleSelected(uid) {
  if (!uid) return;
  if (selectedUids.has(uid)) selectedUids.delete(uid);
  else selectedUids.add(uid);
  emit();
}

// Bulk set (used by marquee drag).
export function setMultiSelection(uids) {
  selectedUids = new Set(uids || []);
  emit();
}

export function addItem(opKey) {
  const spec = OPS[opKey];
  if (!spec) return;
  if (spec.singleton && state.build.some((b) => b.op === opKey)) {
    // Singletons (tee/hole canvas) already exist in initial state; palette should filter them out.
    return;
  }
  beginMutation();
  const defaults = spec.defaults;
  const item = { uid: newId(opKey), op: opKey, pos: [...defaults.pos] };
  if (defaults.scale) item.scale = [...defaults.scale];
  if (typeof defaults.rotY === "number") item.rotY = defaults.rotY;
  if (typeof defaults.terrainLayer === "string") item.terrainLayer = defaults.terrainLayer;
  if (typeof defaults.assetId === "string") item.assetId = defaults.assetId;
  state.build.push(item);
  selectedUids = new Set([item.uid]);
  emit();
  return item.uid;
}

export function updateItem(uid, patch) {
  const item = state.build.find((b) => b.uid === uid);
  if (!item) return;
  beginMutation();
  Object.assign(item, patch);
  emit();
}

export function updateVec(uid, field, index, value) {
  const item = state.build.find((b) => b.uid === uid);
  if (!item || !item[field]) return;
  if (item[field][index] === value) return;
  beginMutation();
  item[field][index] = value;
  emit();
}

// Duplicate every selected non-singleton item, offsetting each by +2m on X so copies are
// visible. Singletons in the selection are skipped silently. Leaves the new copies selected.
export function duplicateSelected() {
  const copies = [];
  // Only commit if there's actually something to copy — avoid a no-op undo step.
  let committed = false;
  for (const uid of selectedUids) {
    const src = state.build.find((b) => b.uid === uid);
    if (!src || OPS[src.op]?.singleton) continue;
    if (!committed) { beginMutation(); committed = true; }
    const copy = JSON.parse(JSON.stringify(src));
    copy.uid = newId(src.op);
    copy.pos = [copy.pos[0] + 2, copy.pos[1], copy.pos[2]];
    state.build.push(copy);
    copies.push(copy.uid);
  }
  if (copies.length) selectedUids = new Set(copies);
  if (committed) emit();
  return copies;
}

export function removeItem(uid) {
  const item = state.build.find((b) => b.uid === uid);
  if (!item) return;
  if (OPS[item.op]?.singleton) return; // cannot remove canvas tee/hole
  beginMutation();
  state.build = state.build.filter((b) => b.uid !== uid);
  selectedUids.delete(uid);
  emit();
}

// Remove every selected non-singleton item in one pass. Keeps the singletons in place.
export function removeSelected() {
  const toRemove = [];
  for (const b of state.build) {
    if (selectedUids.has(b.uid) && !OPS[b.op]?.singleton) toRemove.push(b.uid);
  }
  if (toRemove.length === 0) return;
  beginMutation();
  state.build = state.build.filter((b) => !toRemove.includes(b.uid));
  selectedUids = new Set();
  emit();
}

// Translate every selected item by (dx, dz) on the XZ plane. Used by multi-drag in the view.
export function translateSelected(dx, dz) {
  if (selectedUids.size === 0 || (dx === 0 && dz === 0)) return;
  beginMutation();
  for (const b of state.build) {
    if (!selectedUids.has(b.uid)) continue;
    b.pos[0] += dx;
    b.pos[2] += dz;
  }
  emit();
}

// Export shape: strip UI-only fields (`uid`) so the file matches the runtime-side schema.
export function toMapJson() {
  return {
    schema: SCHEMA_VERSION,
    id: state.id,
    displayName: state.displayName,
    author: state.author,
    par: state.par,
    difficulty: state.difficulty,
    canvas: state.canvas,
    description: state.description,
    cleanCanvas: !!state.cleanCanvas,
    build: state.build.map(({ uid, ...rest }) => rest),
  };
}
