// Top-down 2D canvas view. Renders build items on the XZ plane (Y is hidden; inspector owns it).
//
// Designed so an orbital 3D view can replace it later: the only surface the rest of the app uses
// is `mountView2d(canvas, cursorLabel, zoomLabel)` + the shared state store. All world-space math
// lives in `worldFromScreen` / `screenFromWorld` so any future 3D impl keeps the same ergonomics.
//
// Camera: panX/panZ stored in WORLD units; zoom is pixels-per-world-unit.

import {
  getState, getSelected, getSelectedUids, isSelected,
  setSelected, toggleSelected, setMultiSelection,
  subscribe, updateItem, translateSelected, duplicateSelected, removeSelected,
  undo, redo,
} from "./state.js";
import { OPS } from "./schema.js";
import { getCanvasGhost, subscribeCatalog } from "./asset-catalog.js";

const PPU_DEFAULT = 20;   // pixels per unit at zoom 1×
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8.0;

// Drag snapping: rounds XZ position deltas to this world-space step. 0 means freeform.
// Wired to the top-bar dropdown; defaults to 1m.
let snapStep = 1;
export function setSnapStep(step) { snapStep = step >= 0 ? step : 0; }
function snap(v) {
  if (snapStep <= 0) return Math.round(v * 100) / 100; // freeform: still round to 2dp
  return Math.round(v / snapStep) * snapStep;
}

export function mountView2d(canvas, cursorLabel, zoomLabel) {
  const ctx = canvas.getContext("2d");
  const camera = { panX: 0, panZ: 0, zoom: 1 }; // pan in world space, zoom multiplier

  // Pointer state
  const ptr = {
    panning: false,
    dragging: null,     // item being dragged (primary anchor for the group move)
    dragOffset: null,   // world-space offset between click and item origin
    dragOrigin: null,   // world-space pos of the anchor at drag start (for snap-relative delta)
    lastDeltaApplied: null, // {dx, dz} already pushed to translateSelected so we only apply diffs
    lastScreen: null,   // last pointer screen pos, for panning
    marquee: null,      // { startScreen: [sx, sy], currentScreen: [sx, sy] }
  };

  const resolveCSSColor = (value) => {
    // Resolve var(--x) against :root once per render.
    if (value.startsWith("var(")) {
      const name = value.slice(4, -1).trim();
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#fff";
    }
    return value;
  };

  function ppu() { return PPU_DEFAULT * camera.zoom; }
  function screenFromWorld(x, z) {
    const sx = canvas.width / 2 + (x - camera.panX) * ppu();
    const sy = canvas.height / 2 + (z - camera.panZ) * ppu();    // +Z downward on screen
    return [sx, sy];
  }
  function worldFromScreen(sx, sy) {
    const x = (sx - canvas.width / 2) / ppu() + camera.panX;
    const z = (sy - canvas.height / 2) / ppu() + camera.panZ;
    return [x, z];
  }

  function hitTest(sx, sy) {
    // Topmost-first: reverse iterate so later-added items pick over earlier ones.
    const st = getState();
    for (let i = st.build.length - 1; i >= 0; i--) {
      const item = st.build[i];
      const spec = OPS[item.op];
      if (!spec) continue;
      const fp = spec.footprint(item);
      const [cx, cy] = screenFromWorld(item.pos[0], item.pos[2]);
      const halfW = (fp.x * ppu()) / 2;
      const halfH = (fp.z * ppu()) / 2;
      if (Math.abs(sx - cx) <= halfW && Math.abs(sy - cy) <= halfH) return item;
    }
    return null;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.floor(r.width * dpr);
    canvas.height = Math.floor(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    canvas.width /= dpr; canvas.height /= dpr;
    canvas.width = Math.floor(r.width);
    canvas.height = Math.floor(r.height);
    render();
  }

  function render() {
    ctx.fillStyle = "#141619";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawGrid();
    drawOrigin();
    drawCanvasGhost();

    const st = getState();
    for (const item of st.build) drawItem(item, isSelected(item.uid));

    if (ptr.marquee) drawMarquee();
    if (zoomLabel) zoomLabel.textContent = camera.zoom.toFixed(2) + "×";
  }

  function drawMarquee() {
    const [ax, ay] = ptr.marquee.startScreen;
    const [bx, by] = ptr.marquee.currentScreen;
    const x = Math.min(ax, bx), y = Math.min(ay, by);
    const w = Math.abs(bx - ax), h = Math.abs(by - ay);
    ctx.fillStyle = "rgba(92, 195, 255, 0.12)";
    ctx.strokeStyle = "rgba(92, 195, 255, 0.8)";
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  }

  function drawGrid() {
    const step = 1;
    const stepScreen = step * ppu();
    if (stepScreen < 6) return; // too dense

    const [leftX, topZ] = worldFromScreen(0, 0);
    const [rightX, bottomZ] = worldFromScreen(canvas.width, canvas.height);
    const x0 = Math.floor(leftX / step) * step;
    const z0 = Math.floor(topZ / step) * step;

    ctx.strokeStyle = "#1e232a";
    ctx.lineWidth = 1;
    for (let x = x0; x <= rightX; x += step) {
      const [sx] = screenFromWorld(x, 0);
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, canvas.height); ctx.stroke();
    }
    for (let z = z0; z <= bottomZ; z += step) {
      const [, sy] = screenFromWorld(0, z);
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(canvas.width, sy); ctx.stroke();
    }
    // stronger lines every 5m
    ctx.strokeStyle = "#2c333c";
    for (let x = x0; x <= rightX; x += step) {
      if (x % 5 !== 0) continue;
      const [sx] = screenFromWorld(x, 0);
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, canvas.height); ctx.stroke();
    }
    for (let z = z0; z <= bottomZ; z += step) {
      if (z % 5 !== 0) continue;
      const [, sy] = screenFromWorld(0, z);
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(canvas.width, sy); ctx.stroke();
    }
  }

  // Dimmed reference of where the vanilla tee + flag sit on the selected canvas. Harvested
  // by the plugin (see AssetCatalog.RecordCanvasReference) and loaded via asset-catalog.js.
  // Helps authors anchor their map's scale — "vanilla Twin Beach has its hole ~20m NNE".
  function drawCanvasGhost() {
    const ghost = getCanvasGhost(getState().canvas);
    if (!ghost) return;
    if (ghost.teeLocal) {
      const [sx, sy] = screenFromWorld(ghost.teeLocal[0], ghost.teeLocal[2]);
      ctx.strokeStyle = "rgba(110, 208, 110, 0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(sx, sy, 0.6 * ppu(), 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(110, 208, 110, 0.55)";
      ctx.font = "10px system-ui";
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillText("canvas tee", sx, sy + 0.6 * ppu() + 2);
    }
    if (ghost.holeLocal) {
      const [sx, sy] = screenFromWorld(ghost.holeLocal[0], ghost.holeLocal[2]);
      ctx.strokeStyle = "rgba(255, 122, 122, 0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(sx, sy, 0.4 * ppu(), 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255, 122, 122, 0.55)";
      ctx.font = "10px system-ui";
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillText("canvas flag", sx, sy + 0.4 * ppu() + 2);
    }
  }

  function drawOrigin() {
    const [sx, sy] = screenFromWorld(0, 0);
    ctx.strokeStyle = "#4a5260";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx - 8, sy); ctx.lineTo(sx + 8, sy);
    ctx.moveTo(sx, sy - 8); ctx.lineTo(sx, sy + 8);
    ctx.stroke();
  }

  function drawItem(item, selected) {
    const spec = OPS[item.op];
    if (!spec) return;
    const color = resolveCSSColor(spec.color);
    const fp = spec.footprint(item);
    const [cx, cy] = screenFromWorld(item.pos[0], item.pos[2]);
    const w = fp.x * ppu();
    const h = fp.z * ppu();

    // Round singletons (tee, hole) vs. rectangular cubes/planes. Cubes/planes honor rotY
    // (Y-axis rotation) so authors get a visible orientation cue in the 2D view.
    const circular = item.op === "moveTee" || item.op === "moveHole" || item.op === "spawnHole";
    ctx.fillStyle = withAlpha(color, 0.45);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    if (circular) {
      const r = Math.max(w, h) / 2;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } else {
      const rot = typeof item.rotY === "number" ? item.rotY : 0;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((rot * Math.PI) / 180);
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      // Forward tick (local +X) so rotation is visible at a glance.
      if (rot !== 0) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(w / 2, 0);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.restore();
    }

    if (selected) {
      ctx.strokeStyle = resolveCSSColor("var(--select)");
      ctx.lineWidth = 2;
      const pad = 4;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(cx - w / 2 - pad, cy - h / 2 - pad, w + pad * 2, h + pad * 2);
      ctx.setLineDash([]);
    }

    // label
    ctx.fillStyle = "#11161b";
    ctx.font = "600 11px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(shortLabel(item), cx, cy);
  }

  function shortLabel(item) {
    if (item.op === "moveTee") return "TEE";
    if (item.op === "moveHole") return "⚑";
    if (item.op === "spawnHole") return "⚑";
    if (item.op === "spawnCube") return "▬";
    if (item.op === "spawnPlane") return "▭";
    return "?";
  }

  function withAlpha(colorHex, a) {
    // Accept #rgb / #rrggbb / rgb(...)
    if (colorHex.startsWith("#")) {
      let r, g, b;
      if (colorHex.length === 4) {
        r = parseInt(colorHex[1] + colorHex[1], 16);
        g = parseInt(colorHex[2] + colorHex[2], 16);
        b = parseInt(colorHex[3] + colorHex[3], 16);
      } else {
        r = parseInt(colorHex.slice(1, 3), 16);
        g = parseInt(colorHex.slice(3, 5), 16);
        b = parseInt(colorHex.slice(5, 7), 16);
      }
      return `rgba(${r},${g},${b},${a})`;
    }
    return colorHex;
  }

  // ── Pointer handlers ──

  canvas.addEventListener("mousedown", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const hit = hitTest(sx, sy);

    // Right-click or alt-click: pan camera.
    if (e.button === 2 || (e.button === 0 && e.altKey)) {
      ptr.panning = true;
      ptr.lastScreen = [sx, sy];
      canvas.style.cursor = "grabbing";
      return;
    }

    // Shift+left on empty space: marquee selection.
    if (e.button === 0 && e.shiftKey && !hit) {
      ptr.marquee = { startScreen: [sx, sy], currentScreen: [sx, sy] };
      canvas.style.cursor = "crosshair";
      return;
    }

    // Left on empty space without modifiers: pan + clear selection.
    if (e.button === 0 && !hit) {
      ptr.panning = true;
      ptr.lastScreen = [sx, sy];
      canvas.style.cursor = "grabbing";
      setSelected(null);
      return;
    }

    // Left on an item: select (shift = toggle, plain = exclusive) and begin group drag.
    if (hit) {
      if (e.shiftKey) {
        toggleSelected(hit.uid);
      } else if (!isSelected(hit.uid)) {
        setSelected(hit.uid);
      }
      // Only start a drag if the anchor is part of the current selection.
      if (isSelected(hit.uid)) {
        const [wx, wz] = worldFromScreen(sx, sy);
        ptr.dragging = hit;
        ptr.dragOffset = [wx - hit.pos[0], wz - hit.pos[2]];
        ptr.dragOrigin = [hit.pos[0], hit.pos[2]];
        ptr.lastDeltaApplied = [0, 0];
        canvas.style.cursor = "move";
      }
    }
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const [wx, wz] = worldFromScreen(sx, sy);
    if (cursorLabel) cursorLabel.textContent = `${wx.toFixed(1)}, ${wz.toFixed(1)}`;

    if (ptr.panning && ptr.lastScreen) {
      const [lsx, lsy] = ptr.lastScreen;
      camera.panX -= (sx - lsx) / ppu();
      camera.panZ -= (sy - lsy) / ppu();
      ptr.lastScreen = [sx, sy];
      render();
    } else if (ptr.marquee) {
      ptr.marquee.currentScreen = [sx, sy];
      render();
    } else if (ptr.dragging) {
      // Group translate: compute anchor's desired (snapped) position, diff against what we
      // already applied, push the delta to every selected item. This keeps the group rigid.
      const anchorNewX = snap(wx - ptr.dragOffset[0]);
      const anchorNewZ = snap(wz - ptr.dragOffset[1]);
      const desiredDx = anchorNewX - ptr.dragOrigin[0];
      const desiredDz = anchorNewZ - ptr.dragOrigin[1];
      const [appliedDx, appliedDz] = ptr.lastDeltaApplied;
      const dx = desiredDx - appliedDx;
      const dz = desiredDz - appliedDz;
      if (dx !== 0 || dz !== 0) {
        translateSelected(dx, dz);
        ptr.lastDeltaApplied = [desiredDx, desiredDz];
      }
    }
  });

  const endPtr = () => {
    if (ptr.marquee) commitMarquee();
    ptr.panning = false;
    ptr.dragging = null;
    ptr.lastScreen = null;
    ptr.dragOffset = null;
    ptr.dragOrigin = null;
    ptr.lastDeltaApplied = null;
    ptr.marquee = null;
    canvas.style.cursor = "crosshair";
    render();
  };

  function commitMarquee() {
    const [ax, ay] = ptr.marquee.startScreen;
    const [bx, by] = ptr.marquee.currentScreen;
    // No real drag -> treat as a shift-click on empty, leave selection unchanged.
    if (Math.abs(ax - bx) < 3 && Math.abs(ay - by) < 3) return;
    const minSx = Math.min(ax, bx), maxSx = Math.max(ax, bx);
    const minSy = Math.min(ay, by), maxSy = Math.max(ay, by);
    const hits = [];
    const st = getState();
    for (const item of st.build) {
      const [cx, cy] = screenFromWorld(item.pos[0], item.pos[2]);
      if (cx >= minSx && cx <= maxSx && cy >= minSy && cy <= maxSy) hits.push(item.uid);
    }
    setMultiSelection(hits);
  }
  canvas.addEventListener("mouseup", endPtr);
  canvas.addEventListener("mouseleave", endPtr);

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const [wxBefore, wzBefore] = worldFromScreen(sx, sy);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * factor));
    const [wxAfter, wzAfter] = worldFromScreen(sx, sy);
    camera.panX += wxBefore - wxAfter;
    camera.panZ += wzBefore - wzAfter;
    render();
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    // Never hijack shortcuts while the user is typing in a text field.
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

    const isUndo = (e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z");
    const isRedo = (e.ctrlKey || e.metaKey) && (
      (e.shiftKey && (e.key === "z" || e.key === "Z")) ||
      (e.key === "y" || e.key === "Y")
    );

    if (isUndo) { e.preventDefault(); undo(); return; }
    if (isRedo) { e.preventDefault(); redo(); return; }

    if (e.key === "Delete" || e.key === "Backspace") {
      if (getSelectedUids().length > 0) removeSelected();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      duplicateSelected();
    } else if (e.key === "Escape") {
      setSelected(null);
    }
  });

  window.addEventListener("resize", resize);
  subscribe(render);
  subscribeCatalog(render); // redraw ghosts when a new catalog is loaded
  resize();
}
