// Entry point. Wires the three panels + export button to the shared state store.

import { CANVASES } from "./schema.js";
import { getState, setMeta, subscribe, resetState } from "./state.js";
import { mountPalette } from "./palette.js";
import { mountView2d, setSnapStep } from "./view2d.js";
import { mountView3d, setSnapStep as setSnapStep3d } from "./view3d.js";
import { mountInspector } from "./inspector.js";
import { exportZip, buildExportPackage } from "./export.js";
import { validate } from "./validation.js";
import { importFile } from "./import.js";
import { mountValidationBanner } from "./validation.js";
import { setCustomIconFromFile, clearCustomIcon, getCustomIconDataUrl, subscribeIcon } from "./icon.js";
import { loadCatalogFromFile, getAssets, subscribeCatalog } from "./asset-catalog.js";

// Populate the canvas dropdown from schema.
const canvasSelect = document.getElementById("meta-canvas");
for (const c of CANVASES) {
  const opt = document.createElement("option");
  opt.value = c.id;
  opt.textContent = c.label;
  canvasSelect.appendChild(opt);
}

// Two-way bind metadata inputs <-> state.
const bindings = [
  ["meta-id", "id", "value"],
  ["meta-displayName", "displayName", "value"],
  ["meta-author", "author", "value"],
  ["meta-version", "version", "value"],
  ["meta-par", "par", "valueAsNumber"],
  ["meta-difficulty", "difficulty", "value"],
  ["meta-canvas", "canvas", "value"],
  ["meta-description", "description", "value"],
  ["meta-cleanCanvas", "cleanCanvas", "checked"],
];
for (const [id, key, prop] of bindings) {
  const el = document.getElementById(id);
  el.addEventListener("input", () => setMeta(key, el[prop]));
}
function pushMetaToInputs() {
  const st = getState();
  for (const [id, key, prop] of bindings) {
    const el = document.getElementById(id);
    if (document.activeElement === el) continue; // don't stomp user typing
    el[prop] = st[key];
  }
}
subscribe(pushMetaToInputs);
pushMetaToInputs();

mountPalette(document.getElementById("palette"));
mountInspector(document.getElementById("inspector-body"));
mountView2d(
  document.getElementById("view2d"),
  document.getElementById("hud-cursor"),
  document.getElementById("hud-zoom"),
);

document.getElementById("btn-export").addEventListener("click", exportZip);

// Preview: validate, build the zip in memory, show a modal with file sizes.
const previewModal = document.getElementById("preview-modal");
document.getElementById("btn-preview").addEventListener("click", async () => {
  if (validate().length) { document.getElementById("btn-export")?.animate([{background:"var(--danger)"},{background:"var(--accent)"}],{duration:400}); return; }
  const { fileName, entries, totalSize } = await buildExportPackage();
  document.getElementById("preview-filename").textContent = fileName;
  document.getElementById("preview-totalsize").textContent = "zip: " + formatBytes(totalSize);
  const tbody = previewModal.querySelector("tbody");
  tbody.innerHTML = "";
  for (const e of entries) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${e.name}</td><td>${formatBytes(e.size)}</td>`;
    tbody.appendChild(tr);
  }
  previewModal.hidden = false;
});
document.getElementById("btn-preview-close").addEventListener("click", () => { previewModal.hidden = true; });
previewModal.addEventListener("click", (e) => { if (e.target === previewModal) previewModal.hidden = true; });

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(2) + " MB";
}

// Snap-to-grid selector. 0 = off/freeform (still rounds to 2dp to keep JSON clean).
// Both views hold their own snap state; we broadcast to both so the dropdown stays authoritative
// without any view needing to reach into the other's module.
const snapSelect = document.getElementById("snap-size");
const applySnap = () => {
  const step = parseFloat(snapSelect.value);
  setSnapStep(step);
  setSnapStep3d(step);
};
snapSelect.addEventListener("change", applySnap);
applySnap();

// View toggle. 3D view is mounted lazily — three.js import + scene setup is heavier than 2D.
const view2dCanvas = document.getElementById("view2d");
const view3dCanvas = document.getElementById("view3d");
const btn2d = document.getElementById("btn-view-2d");
const btn3d = document.getElementById("btn-view-3d");
let mounted3d = false;
btn2d.addEventListener("click", () => {
  view2dCanvas.hidden = false;
  view3dCanvas.hidden = true;
  btn2d.classList.add("active");
  btn3d.classList.remove("active");
});
btn3d.addEventListener("click", () => {
  if (!mounted3d) {
    mountView3d(
      view3dCanvas,
      document.getElementById("hud-cursor"),
      document.getElementById("hud-zoom"),
    );
    mounted3d = true;
    // Re-apply the snap value so 3D starts with the same step as 2D.
    applySnap();
  }
  view2dCanvas.hidden = true;
  view3dCanvas.hidden = false;
  btn3d.classList.add("active");
  btn2d.classList.remove("active");
  // Canvas dimensions are zero while hidden — trigger a layout-dependent resize by
  // dispatching the resize event listeners view3d installed.
  window.dispatchEvent(new Event("resize"));
});

// Inline validation banner replaces the old alert() on export.
mountValidationBanner(document.getElementById("validation"));

// Open / Import: file picker + drag-drop onto the viewport. Both paths go through importFile
// which handles .mapjson directly and unpacks .zip to find the embedded .mapjson.
const fileInput = document.getElementById("file-input");
document.getElementById("btn-open").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (file) await handleImport(file);
  fileInput.value = ""; // let the same file be re-picked
});

const viewport = document.getElementById("viewport");
viewport.addEventListener("dragover", (e) => {
  e.preventDefault();
  viewport.classList.add("drop-target");
});
viewport.addEventListener("dragleave", () => viewport.classList.remove("drop-target"));
viewport.addEventListener("drop", async (e) => {
  e.preventDefault();
  viewport.classList.remove("drop-target");
  const file = e.dataTransfer?.files?.[0];
  if (file) await handleImport(file);
});

async function handleImport(file) {
  const { ok, error } = await importFile(file);
  if (!ok) alert("Import failed: " + error);
}

// Reset clears the editor + autosave after confirming.
document.getElementById("btn-reset").addEventListener("click", () => {
  if (confirm("Clear the current map? This also wipes the autosave.")) resetState();
});

// Starter samples. Loads samples/index.json at startup and populates the dropdown.
const samplesPicker = document.getElementById("samples-picker");
(async function loadSamples() {
  try {
    const idx = await (await fetch("samples/index.json", { cache: "no-cache" })).json();
    for (const s of (idx.samples ?? [])) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.label || s.id;
      samplesPicker.appendChild(opt);
    }
  } catch {
    // Samples dir missing — not fatal, just leaves the picker empty.
  }
})();
// Asset catalog — user loads the plugin's sbg-asset-catalog.json to populate the picker.
const catalogInput = document.getElementById("catalog-input");
const btnCatalog = document.getElementById("btn-catalog");
btnCatalog.addEventListener("click", () => catalogInput.click());
catalogInput.addEventListener("change", async () => {
  const file = catalogInput.files?.[0];
  catalogInput.value = "";
  if (!file) return;
  const { ok, error, count } = await loadCatalogFromFile(file);
  if (!ok) alert("Catalog load failed: " + error);
  else refreshCatalogLabel();
});
function refreshCatalogLabel() {
  const n = getAssets().length;
  btnCatalog.textContent = n > 0 ? `Catalog: ${n}` : "Load catalog…";
}
subscribeCatalog(refreshCatalogLabel);
refreshCatalogLabel();

// Help panel toggle. Click the ? floating button or press F1.
const helpPanel = document.getElementById("help-panel");
const btnHelp = document.getElementById("btn-help");
btnHelp.addEventListener("click", () => { helpPanel.hidden = !helpPanel.hidden; });
window.addEventListener("keydown", (e) => {
  if (e.key === "F1") { e.preventDefault(); helpPanel.hidden = !helpPanel.hidden; }
  else if (e.key === "Escape" && !helpPanel.hidden) helpPanel.hidden = true;
});

samplesPicker.addEventListener("change", async () => {
  const id = samplesPicker.value;
  samplesPicker.value = "";
  if (!id) return;
  if (!confirm("Load sample '" + id + "'? This replaces the current map (undoable).")) return;
  try {
    const res = await fetch(`samples/${id}.mapjson`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const file = new File([await res.blob()], `${id}.mapjson`, { type: "application/json" });
    const { ok, error } = await importFile(file);
    if (!ok) alert("Sample load failed: " + error);
  } catch (err) {
    alert("Sample load failed: " + (err?.message || String(err)));
  }
});

// Custom icon upload: one button opens the picker, the "×" clears back to auto-generated.
const iconInput = document.getElementById("icon-input");
const iconPreview = document.getElementById("icon-preview");
document.getElementById("btn-icon").addEventListener("click", () => iconInput.click());
iconInput.addEventListener("change", async () => {
  const file = iconInput.files?.[0];
  iconInput.value = "";
  if (!file) return;
  try { await setCustomIconFromFile(file); }
  catch (err) { alert(err?.message || String(err)); }
});
document.getElementById("btn-icon-clear").addEventListener("click", () => clearCustomIcon());
function refreshIconPreview() {
  const url = getCustomIconDataUrl();
  if (url) iconPreview.setAttribute("src", url);
  else iconPreview.removeAttribute("src");
}
subscribeIcon(refreshIconPreview);
refreshIconPreview();
