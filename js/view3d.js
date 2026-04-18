// Orbital 3D viewport. Same contract as view2d: mountView3d(canvas, cursorLabel, zoomLabel).
// Hand-rolled orbit controls because OrbitControls would require a second CDN import and its
// event semantics don't match ours anyway (we need left-drag pan + middle/right orbit + shift
// marquee, which OrbitControls doesn't express cleanly).
//
// Rendering strategy: one Mesh per build item, reconciled on each state tick via a Map keyed
// by uid. We don't rebuild the scene; we add/remove/update in-place so the GPU and GC both stay
// quiet during drags.

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";
import {
  getState, getSelectedUids, isSelected,
  setSelected, toggleSelected, setMultiSelection,
  subscribe, translateSelected, duplicateSelected, removeSelected, undo, redo,
} from "./state.js";
import { OPS } from "./schema.js";

// Local snap mirror. main.js wires both views' setters to the same dropdown; we don't reach into
// view2d's module to avoid coupling. Rounding to 2dp when off matches view2d.
let snapStep = 1;
export function setSnapStep(step) { snapStep = step >= 0 ? step : 0; }
function snap(v) {
  if (snapStep <= 0) return Math.round(v * 100) / 100;
  return Math.round(v / snapStep) * snapStep;
}

const resolveCSSVar = (value) => {
  if (typeof value === "string" && value.startsWith("var(")) {
    const name = value.slice(4, -1).trim();
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#ffffff";
  }
  return value;
};

export function mountView3d(canvas, cursorLabel, zoomLabel) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(resolveCSSVar("var(--bg)"));

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  // Orbit state kept in spherical coords around `target`. Easier to clamp than matrix math.
  const target = new THREE.Vector3(0, 0, 0);
  const orbit = { radius: Math.hypot(12, 10, 12), theta: Math.PI / 4, phi: Math.PI / 3.2 };
  const MIN_R = 2, MAX_R = 100;
  const MIN_PHI = 0.05, MAX_PHI = Math.PI / 2 - 0.02; // clamp above ground; never below horizon

  function applyCamera() {
    const r = orbit.radius;
    camera.position.set(
      target.x + r * Math.sin(orbit.phi) * Math.sin(orbit.theta),
      target.y + r * Math.cos(orbit.phi),
      target.z + r * Math.sin(orbit.phi) * Math.cos(orbit.theta),
    );
    camera.lookAt(target);
    if (zoomLabel) zoomLabel.textContent = "d=" + orbit.radius.toFixed(1);
  }

  // Lights — one key directional + mild ambient so top/side faces both read without PBR setup.
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.85);
  keyLight.position.set(8, 14, 6);
  scene.add(keyLight);

  // Grid: 1m minor, 5m major, 120 units wide. Three.js GridHelper accepts only two colors so we
  // stack two helpers — a dense subtle one and a sparse stronger one.
  const gridMinor = new THREE.GridHelper(120, 120, 0x2c333c, 0x1e232a);
  gridMinor.material.transparent = true; gridMinor.material.opacity = 0.55;
  scene.add(gridMinor);
  const gridMajor = new THREE.GridHelper(120, 24, 0x3a434e, 0x3a434e);
  gridMajor.material.transparent = true; gridMajor.material.opacity = 0.75;
  scene.add(gridMajor);

  // Origin axes triad so "which way is +X" is never a mystery.
  const axes = new THREE.AxesHelper(1.5);
  scene.add(axes);

  // ── Mesh factory ─────────────────────────────────────────────────────────
  // Each item op maps to a THREE.Group so we can compose (e.g. hole = pole + flag) and still
  // carry a single parent transform. The root group's `userData.uid` is what raycasts return.
  function buildMesh(item) {
    const spec = OPS[item.op];
    const color = new THREE.Color(resolveCSSVar(spec.color));
    const g = new THREE.Group();
    g.userData.uid = item.uid;

    if (item.op === "moveTee") {
      const geo = new THREE.CylinderGeometry(0.5, 0.5, 0.2, 24);
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color }));
      m.position.y = 0.1;
      m.userData.pickUid = item.uid;
      g.add(m);
    } else if (item.op === "moveHole" || item.op === "spawnHole") {
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, 2, 12),
        new THREE.MeshStandardMaterial({ color }),
      );
      pole.position.y = 1;
      pole.userData.pickUid = item.uid;
      g.add(pole);
      const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(0.8, 0.4),
        new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide }),
      );
      flag.position.set(0.4, 1.7, 0);
      flag.userData.pickUid = item.uid;
      g.add(flag);
    } else if (item.op === "spawnCube" || item.op === "spawnPlane") {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color }),
      );
      box.userData.pickUid = item.uid;
      g.add(box);
    }
    return g;
  }

  // Push per-frame transform from state into mesh. Cheaper than destroy/create on every drag.
  function syncMesh(g, item) {
    g.position.set(item.pos[0], item.pos[1], item.pos[2]);
    const rot = typeof item.rotY === "number" ? (item.rotY * Math.PI) / 180 : 0;
    g.rotation.set(0, rot, 0);
    // Scale lives on the first child (the box) for cube/plane; tee/hole stay 1×.
    const child = g.children[0];
    if (item.op === "spawnCube" && item.scale) {
      child.scale.set(item.scale[0], item.scale[1], item.scale[2]);
    } else if (item.op === "spawnPlane" && item.scale) {
      // PlaneGeometry in game scales XZ by 10×; Y is thin so the plane reads as a slab.
      child.scale.set(item.scale[0] * 10, 0.05, item.scale[2] * 10);
    }
  }

  const meshByUid = new Map();           // uid -> THREE.Group
  const selectionHelpers = new Map();    // uid -> BoxHelper
  const selectColor = new THREE.Color(resolveCSSVar("var(--select)"));

  function reconcile() {
    const st = getState();
    const live = new Set();
    for (const item of st.build) {
      live.add(item.uid);
      let g = meshByUid.get(item.uid);
      if (!g) {
        g = buildMesh(item);
        scene.add(g);
        meshByUid.set(item.uid, g);
      }
      syncMesh(g, item);
    }
    for (const [uid, g] of meshByUid) {
      if (live.has(uid)) continue;
      scene.remove(g);
      meshByUid.delete(uid);
    }
    // Selection wireframes: add/update/remove to match selectedUids.
    const selected = new Set(getSelectedUids());
    for (const uid of selected) {
      const g = meshByUid.get(uid);
      if (!g) continue;
      let helper = selectionHelpers.get(uid);
      if (!helper) {
        helper = new THREE.BoxHelper(g, selectColor);
        scene.add(helper);
        selectionHelpers.set(uid, helper);
      } else {
        helper.setFromObject(g);
      }
    }
    for (const [uid, h] of selectionHelpers) {
      if (selected.has(uid)) continue;
      scene.remove(h);
      h.geometry.dispose();
      selectionHelpers.delete(uid);
    }
    render();
  }

  // ── Picking ──────────────────────────────────────────────────────────────
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function screenToNdc(sx, sy) {
    const r = canvas.getBoundingClientRect();
    ndc.set((sx / r.width) * 2 - 1, -(sy / r.height) * 2 + 1);
  }

  function pickUid(sx, sy) {
    screenToNdc(sx, sy);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects([...meshByUid.values()], true);
    for (const h of hits) {
      // Walk up to the group carrying userData.uid.
      let o = h.object;
      while (o && !o.userData?.uid) o = o.parent;
      if (o?.userData?.uid) return o.userData.uid;
    }
    return null;
  }

  // Ground-plane intersection at y=planeY. Returns null if the ray is parallel.
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const tmpVec = new THREE.Vector3();
  function intersectPlane(sx, sy, planeY) {
    screenToNdc(sx, sy);
    raycaster.setFromCamera(ndc, camera);
    groundPlane.constant = -planeY; // plane: y = planeY  →  n·p + d = 0 with n=(0,1,0) gives d = -planeY
    const hit = raycaster.ray.intersectPlane(groundPlane, tmpVec);
    return hit ? [hit.x, hit.z] : null;
  }

  // ── Pointer state (mirrors view2d) ────────────────────────────────────────
  const ptr = {
    orbiting: false,
    panning: false,
    dragging: null,           // item (state object) being dragged
    dragOffset: null,         // [dx, dz] between click-world and item origin
    dragOrigin: null,         // anchor pos at drag start
    lastDeltaApplied: null,   // [dx, dz] already pushed to translateSelected
    dragPlaneY: 0,            // y of the anchor item, projected each move
    lastScreen: null,
    marquee: null,            // {startScreen, currentScreen}
  };

  // Marquee overlay: a plain div is simpler than an ortho camera layer.
  const marqueeEl = document.createElement("div");
  marqueeEl.style.cssText =
    "position:absolute;border:1px solid rgba(92,195,255,0.8);" +
    "background:rgba(92,195,255,0.12);pointer-events:none;display:none;";
  canvas.parentElement?.appendChild(marqueeEl);

  function drawMarquee() {
    if (!ptr.marquee) { marqueeEl.style.display = "none"; return; }
    const [ax, ay] = ptr.marquee.startScreen;
    const [bx, by] = ptr.marquee.currentScreen;
    const r = canvas.getBoundingClientRect();
    const parent = canvas.parentElement.getBoundingClientRect();
    const offX = r.left - parent.left, offY = r.top - parent.top;
    marqueeEl.style.left = offX + Math.min(ax, bx) + "px";
    marqueeEl.style.top = offY + Math.min(ay, by) + "px";
    marqueeEl.style.width = Math.abs(bx - ax) + "px";
    marqueeEl.style.height = Math.abs(by - ay) + "px";
    marqueeEl.style.display = "block";
  }

  function projectToScreen(worldX, worldY, worldZ) {
    tmpVec.set(worldX, worldY, worldZ).project(camera);
    const r = canvas.getBoundingClientRect();
    return [(tmpVec.x + 1) * 0.5 * r.width, (1 - (tmpVec.y + 1) * 0.5) * r.height];
  }

  canvas.addEventListener("mousedown", (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;

    // Middle/right-drag on empty → orbit. (Middle = button 1, right = 2.)
    if (e.button === 1 || e.button === 2) {
      ptr.orbiting = true;
      ptr.lastScreen = [sx, sy];
      canvas.style.cursor = "grabbing";
      return;
    }

    const uid = pickUid(sx, sy);

    // Shift+left on empty → marquee.
    if (e.button === 0 && e.shiftKey && !uid) {
      ptr.marquee = { startScreen: [sx, sy], currentScreen: [sx, sy] };
      drawMarquee();
      return;
    }

    // Left on empty (no shift) → clear selection + pan.
    if (e.button === 0 && !uid) {
      ptr.panning = true;
      ptr.lastScreen = [sx, sy];
      canvas.style.cursor = "grabbing";
      setSelected(null);
      return;
    }

    // Left on item → select (shift=toggle) and start group drag if part of selection.
    if (uid) {
      if (e.shiftKey) toggleSelected(uid);
      else if (!isSelected(uid)) setSelected(uid);

      if (isSelected(uid)) {
        const item = getState().build.find((b) => b.uid === uid);
        if (!item) return;
        const world = intersectPlane(sx, sy, item.pos[1]);
        if (!world) return;
        ptr.dragging = item;
        ptr.dragPlaneY = item.pos[1];
        ptr.dragOffset = [world[0] - item.pos[0], world[1] - item.pos[2]];
        ptr.dragOrigin = [item.pos[0], item.pos[2]];
        ptr.lastDeltaApplied = [0, 0];
        canvas.style.cursor = "move";
      }
    }
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  canvas.addEventListener("mousemove", (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;

    // HUD: world X,Z under cursor on ground plane.
    const ground = intersectPlane(sx, sy, 0);
    if (ground && cursorLabel) cursorLabel.textContent = `${ground[0].toFixed(1)}, ${ground[1].toFixed(1)}`;

    if (ptr.orbiting && ptr.lastScreen) {
      const [lsx, lsy] = ptr.lastScreen;
      orbit.theta -= (sx - lsx) * 0.008;
      orbit.phi   -= (sy - lsy) * 0.008;
      orbit.phi = Math.max(MIN_PHI, Math.min(MAX_PHI, orbit.phi));
      ptr.lastScreen = [sx, sy];
      applyCamera(); render();
    } else if (ptr.panning && ptr.lastScreen) {
      // Pan the target along camera-right / camera-forward-projected-to-XZ so "drag left" feels
      // like the world pushes right, matching the 2D view.
      const [lsx, lsy] = ptr.lastScreen;
      const dx = sx - lsx, dy = sy - lsy;
      const pxPerWorld = canvas.clientHeight / (2 * orbit.radius * Math.tan((camera.fov * Math.PI / 180) / 2));
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      const up    = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
      right.y = 0; right.normalize();
      up.y = 0; up.normalize(); // project camera-up onto XZ for intuitive screen-up = forward
      target.addScaledVector(right, -dx / pxPerWorld);
      target.addScaledVector(up,     dy / pxPerWorld);
      ptr.lastScreen = [sx, sy];
      applyCamera(); render();
    } else if (ptr.marquee) {
      ptr.marquee.currentScreen = [sx, sy];
      drawMarquee();
    } else if (ptr.dragging) {
      const world = intersectPlane(sx, sy, ptr.dragPlaneY);
      if (!world) return;
      const anchorNewX = snap(world[0] - ptr.dragOffset[0]);
      const anchorNewZ = snap(world[1] - ptr.dragOffset[1]);
      const desiredDx = anchorNewX - ptr.dragOrigin[0];
      const desiredDz = anchorNewZ - ptr.dragOrigin[1];
      const [appliedDx, appliedDz] = ptr.lastDeltaApplied;
      const dx = desiredDx - appliedDx;
      const dz = desiredDz - appliedDz;
      if (dx !== 0 || dz !== 0) {
        translateSelected(dx, dz);           // will emit and trigger reconcile → redraw
        ptr.lastDeltaApplied = [desiredDx, desiredDz];
      }
    }
  });

  const endPtr = () => {
    if (ptr.marquee) commitMarquee();
    ptr.orbiting = false;
    ptr.panning = false;
    ptr.dragging = null;
    ptr.lastScreen = null;
    ptr.dragOffset = null;
    ptr.dragOrigin = null;
    ptr.lastDeltaApplied = null;
    ptr.marquee = null;
    drawMarquee();
    canvas.style.cursor = "default";
  };
  canvas.addEventListener("mouseup", endPtr);
  canvas.addEventListener("mouseleave", endPtr);

  function commitMarquee() {
    const [ax, ay] = ptr.marquee.startScreen;
    const [bx, by] = ptr.marquee.currentScreen;
    if (Math.abs(ax - bx) < 3 && Math.abs(ay - by) < 3) return;
    const minSx = Math.min(ax, bx), maxSx = Math.max(ax, bx);
    const minSy = Math.min(ay, by), maxSy = Math.max(ay, by);
    const hits = [];
    const st = getState();
    for (const item of st.build) {
      const [cx, cy] = projectToScreen(item.pos[0], item.pos[1], item.pos[2]);
      if (cx >= minSx && cx <= maxSx && cy >= minSy && cy <= maxSy) hits.push(item.uid);
    }
    setMultiSelection(hits);
  }

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1 / 1.15 : 1.15;
    orbit.radius = Math.min(MAX_R, Math.max(MIN_R, orbit.radius * factor));
    applyCamera(); render();
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    // Don't hijack while typing — same guard as view2d.
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    // Only act when the 3D canvas is actually the visible view. Cheap check: its `hidden` attr.
    if (canvas.hasAttribute("hidden")) return;

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

  function resize() {
    const r = canvas.getBoundingClientRect();
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / Math.max(1, r.height);
    camera.updateProjectionMatrix();
    render();
  }

  function render() {
    renderer.render(scene, camera);
  }

  window.addEventListener("resize", resize);
  subscribe(reconcile);
  applyCamera();
  resize();
  reconcile();
}
