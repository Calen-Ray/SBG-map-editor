// Modal picker over the loaded asset catalog. Authors click one of the harvested assets;
// the selected entry's id is written into a new `spawnAsset` op by the palette.
//
// The catalog is whatever the plugin most recently wrote to
// BepInEx/cache/sbg-asset-catalog.json — the user uploads it via the "Load catalog" button
// wired from main.js.

import { getAssets, subscribeCatalog } from "./asset-catalog.js";

let modalEl = null;
let currentResolver = null;

function ensureModal() {
  if (modalEl) return modalEl;
  modalEl = document.createElement("div");
  modalEl.id = "asset-picker-modal";
  modalEl.hidden = true;
  modalEl.innerHTML = `
    <div class="asset-body">
      <div class="asset-header">
        <strong>Pick a game asset</strong>
        <input id="asset-filter" placeholder="Filter by name or category" />
        <button id="asset-close" type="button" class="secondary">×</button>
      </div>
      <p id="asset-empty" class="note hidden">No assets in catalog yet. In the game, play any hole once — the plugin writes
      <code>BepInEx/cache/sbg-asset-catalog.json</code>. Load that file via <strong>Load catalog…</strong> in the top bar.</p>
      <ul id="asset-list"></ul>
    </div>
  `;
  document.body.appendChild(modalEl);

  modalEl.querySelector("#asset-close").addEventListener("click", () => closePicker(null));
  modalEl.addEventListener("click", (e) => { if (e.target === modalEl) closePicker(null); });
  modalEl.querySelector("#asset-filter").addEventListener("input", render);
  subscribeCatalog(render);
  return modalEl;
}

function render() {
  if (!modalEl) return;
  const list = modalEl.querySelector("#asset-list");
  const empty = modalEl.querySelector("#asset-empty");
  const filterText = modalEl.querySelector("#asset-filter").value.trim().toLowerCase();
  const assets = getAssets().filter((a) => {
    if (!filterText) return true;
    return (a.id || "").toLowerCase().includes(filterText)
        || (a.category || "").toLowerCase().includes(filterText)
        || (a.name || "").toLowerCase().includes(filterText);
  });
  list.innerHTML = "";
  empty.classList.toggle("hidden", assets.length > 0);
  for (const a of assets) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="asset-cat">${a.category || "prop"}</span>
      <span class="asset-id">${a.id}</span>
    `;
    li.addEventListener("click", () => closePicker(a));
    list.appendChild(li);
  }
}

function closePicker(result) {
  if (modalEl) modalEl.hidden = true;
  const r = currentResolver; currentResolver = null;
  if (r) r(result);
}

// Returns the chosen asset, or null if cancelled.
export function openAssetPicker() {
  ensureModal();
  render();
  modalEl.hidden = false;
  modalEl.querySelector("#asset-filter").focus();
  return new Promise((resolve) => { currentResolver = resolve; });
}
