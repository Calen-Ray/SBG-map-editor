// Right panel: shows the currently-selected item's position/scale fields.
// Also re-renders on state changes so drag-in-view updates the numeric inputs in lockstep.

import { OPS, TERRAIN_LAYERS } from "./schema.js";
import {
  getSelected, getSelectedUids, getState,
  removeItem, removeSelected, duplicateSelected,
  subscribe, updateItem, updateVec, translateSelected,
} from "./state.js";

export function mountInspector(root) {
  const render = () => {
    const uids = getSelectedUids();
    root.innerHTML = "";

    if (uids.length === 0) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "Select an object to edit.";
      root.appendChild(p);
      return;
    }

    if (uids.length > 1) {
      renderMultiSelect(root, uids);
      return;
    }

    const sel = getSelected();
    if (!sel) return;
    const spec = OPS[sel.op];
    if (!spec) return;

    const title = document.createElement("div");
    title.innerHTML = `<strong>${spec.label}</strong> <code style="color:var(--muted)">${sel.uid}</code>`;
    title.style.marginBottom = "8px";
    root.appendChild(title);

    if (spec.singleton) {
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = "Canvas original — can only be moved, not removed.";
      root.appendChild(note);
    }

    // Position (always present)
    appendVec(root, "Position", "pos", sel);
    // Scale (cube/plane)
    if (sel.scale) appendVec(root, "Scale", "scale", sel);
    // Y-rotation (cube/plane, degrees around Y axis)
    if (typeof sel.rotY === "number") appendScalar(root, "Rot Y°", "rotY", sel);
    // Terrain layer (cube/plane) — drives in-game ball physics / footstep audio / OOB behavior.
    if (typeof sel.terrainLayer === "string") appendTerrainLayer(root, sel);
    // Asset id (spawnAsset) — read-only label + button to change via picker.
    if (typeof sel.assetId === "string") appendAssetId(root, sel);

    if (!spec.singleton) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "delete";
      del.textContent = "Delete";
      del.addEventListener("click", () => removeItem(sel.uid));
      root.appendChild(del);
    }
  };

  subscribe(render);
  render();
}

// Compact panel for multi-selection: counts, aggregated numeric fields, batch commands.
// Position X/Y/Z shows the shared value if all items match, and blank otherwise; editing
// applies the *delta* to every selected item so the group stays rigid. Scale/rotY only
// show when every selected item has that field; otherwise the input is omitted.
function renderMultiSelect(root, uids) {
  const st = getState();
  const items = uids.map((uid) => st.build.find((b) => b.uid === uid)).filter(Boolean);
  const byOp = new Map();
  let singletonCount = 0;
  for (const item of items) {
    if (OPS[item.op]?.singleton) singletonCount++;
    byOp.set(item.op, (byOp.get(item.op) ?? 0) + 1);
  }

  const header = document.createElement("div");
  header.innerHTML = `<strong>${uids.length} selected</strong>`;
  header.style.marginBottom = "6px";
  root.appendChild(header);

  const breakdown = document.createElement("p");
  breakdown.className = "note";
  breakdown.textContent = [...byOp.entries()].map(([op, n]) => `${n}× ${OPS[op]?.label || op}`).join(", ");
  root.appendChild(breakdown);

  if (singletonCount > 0) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = `${singletonCount} canvas singleton(s) will be skipped by Delete/Duplicate.`;
    root.appendChild(note);
  }

  // Position aggregate: editing any axis translates every selected item by the delta from
  // its old common value. Works even when initial axis values differ (treated as "∆ = 0"
  // baseline — user edits from the current state).
  appendMultiVec(root, "Position", "pos", items);
  // Scale only makes sense when every selection has it (cubes/planes). Otherwise skip.
  if (items.every((i) => i.scale)) appendMultiVec(root, "Scale", "scale", items, /*translate*/ false);
  // Y-rotation scalar.
  if (items.every((i) => typeof i.rotY === "number")) appendMultiScalar(root, "Rot Y°", "rotY", items);
  if (items.every((i) => typeof i.terrainLayer === "string")) appendMultiTerrain(root, items);

  const dup = document.createElement("button");
  dup.type = "button";
  dup.className = "secondary";
  dup.style.width = "100%";
  dup.style.marginTop = "6px";
  dup.textContent = "Duplicate  (Ctrl+D)";
  dup.addEventListener("click", () => duplicateSelected());
  root.appendChild(dup);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "delete";
  del.textContent = "Delete selection  (Del)";
  del.addEventListener("click", () => removeSelected());
  root.appendChild(del);
}

// Render a 3-axis field where each axis shows the shared value or is blank when mixed.
// `translate` — if true, position-style: editing applies a delta to every selected item
// (including ones that don't share the same starting value). If false, scale-style: each
// axis is set to the literal typed value on every selected item.
function appendMultiVec(root, label, field, items, translate = true) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.innerHTML = `<span>${label}</span><div class="vec3"></div>`;
  const row = wrap.querySelector(".vec3");
  const titles = ["X", "Y", "Z"];

  for (let axis = 0; axis < 3; axis++) {
    const shared = sharedValue(items, field, axis);
    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.1";
    input.title = titles[axis];
    if (shared !== null) input.value = shared;
    else { input.placeholder = "—"; input.value = ""; }

    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      if (!Number.isFinite(v)) return;
      if (translate && field === "pos") {
        // Compare against current shared — if mixed, treat the old value as each item's own
        // current value (delta per-item).
        if (shared !== null && axis !== 1) {
          // Fast path for X/Z: use translateSelected to keep group rigid + undo coalescing.
          if (axis === 0) translateSelected(v - shared, 0);
          if (axis === 2) translateSelected(0, v - shared);
        } else {
          // Y-axis or mixed-start: write individually.
          for (const it of items) updateVec(it.uid, field, axis, v);
        }
      } else {
        for (const it of items) updateVec(it.uid, field, axis, v);
      }
    });
    row.appendChild(input);
  }
  root.appendChild(wrap);
}

function appendMultiScalar(root, label, field, items) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.innerHTML = `<span>${label}</span>`;
  const input = document.createElement("input");
  input.type = "number";
  input.step = "5";
  const shared = sharedScalar(items, field);
  if (shared !== null) input.value = shared;
  else { input.placeholder = "—"; input.value = ""; }
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return;
    for (const it of items) updateItem(it.uid, { [field]: v });
  });
  wrap.appendChild(input);
  root.appendChild(wrap);
}

function appendMultiTerrain(root, items) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.innerHTML = `<span>Terrain</span>`;
  const select = document.createElement("select");
  select.className = "terrain-select";
  const allShared = items.every((i) => i.terrainLayer === items[0].terrainLayer);
  if (!allShared) {
    const mixed = document.createElement("option");
    mixed.value = "__mixed__";
    mixed.textContent = "— mixed —";
    select.appendChild(mixed);
  }
  for (const l of TERRAIN_LAYERS) {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.label;
    select.appendChild(opt);
  }
  select.value = allShared ? (items[0].terrainLayer ?? "") : "__mixed__";
  select.addEventListener("change", () => {
    if (select.value === "__mixed__") return;
    for (const it of items) updateItem(it.uid, { terrainLayer: select.value });
  });
  wrap.appendChild(select);
  root.appendChild(wrap);
}

function sharedValue(items, field, axis) {
  let seen = null;
  for (const it of items) {
    const v = it?.[field]?.[axis];
    if (!Number.isFinite(v)) return null;
    if (seen === null) seen = v;
    else if (v !== seen) return null;
  }
  return seen;
}
function sharedScalar(items, field) {
  let seen = null;
  for (const it of items) {
    const v = it?.[field];
    if (!Number.isFinite(v)) return null;
    if (seen === null) seen = v;
    else if (v !== seen) return null;
  }
  return seen;
}

function appendAssetId(root, item) {
  const wrap = document.createElement("div");
  wrap.className = "field asset-id-row";
  wrap.innerHTML = `<span>Asset</span>`;
  const info = document.createElement("div");
  info.className = "asset-id-display";
  info.textContent = item.assetId || "(none — click Pick)";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "secondary";
  btn.textContent = "Pick…";
  btn.addEventListener("click", async () => {
    const { openAssetPicker } = await import("./asset-picker.js");
    const pick = await openAssetPicker();
    if (pick) updateItem(item.uid, { assetId: pick.id });
  });
  const cell = document.createElement("div");
  cell.style.display = "flex";
  cell.style.gap = "4px";
  cell.style.alignItems = "center";
  cell.appendChild(info);
  cell.appendChild(btn);
  wrap.appendChild(cell);
  root.appendChild(wrap);
}

function appendTerrainLayer(root, item) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.innerHTML = `<span>Terrain</span>`;
  const select = document.createElement("select");
  select.className = "terrain-select";
  for (const l of TERRAIN_LAYERS) {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.label;
    select.appendChild(opt);
  }
  select.value = item.terrainLayer ?? "";
  select.addEventListener("change", () => updateItem(item.uid, { terrainLayer: select.value }));
  wrap.appendChild(select);
  root.appendChild(wrap);
}

function appendScalar(root, label, field, item) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.innerHTML = `<span>${label}</span>`;
  const input = document.createElement("input");
  input.type = "number";
  input.step = "5";
  input.value = item[field];
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) updateItem(item.uid, { [field]: v });
  });
  wrap.appendChild(input);
  root.appendChild(wrap);
}

function appendVec(root, label, field, item) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.innerHTML = `<span>${label}</span><div class="vec3"></div>`;
  const row = wrap.querySelector(".vec3");
  const axes = ["X", "Y", "Z"];
  for (let i = 0; i < 3; i++) {
    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.1";
    input.value = item[field][i];
    input.title = axes[i];
    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) updateVec(item.uid, field, i, v);
    });
    row.appendChild(input);
  }
  root.appendChild(wrap);
}
