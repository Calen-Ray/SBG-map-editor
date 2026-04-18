// Authoritative schema for ops + canvas scenes. Both the editor UI (palette, view,
// inspector) and the export pipeline read from here. Add an op or canvas once, everything
// else picks it up automatically.

// Schema is append-only within a major version. Ops added to OPS read optional fields; the
// plugin-side loader ignores unknown fields too. Bump only if we break existing .mapjson files.
export const SCHEMA_VERSION = 1;

// Primitive op table. Each entry:
//   op         - key written to .mapjson, matches runtime dispatcher.
//   label      - palette button.
//   color      - CSS color used for the 2D view swatch + outline.
//   singleton  - true for tee/hole; only one instance ever in the build list.
//   defaults   - initial pos/scale when added by palette click.
//   fields     - which numeric fields show in the inspector (pos is implicit).
//   footprint  - (x, z) size in world units used for 2D rendering and hit testing.
//                If it's a function, it's computed from the instance (cube/plane use scale).
export const OPS = {
  moveTee: {
    op: "moveTee",
    label: "Tee (canvas)",
    color: "var(--tee)",
    singleton: true,
    defaults: { pos: [0, 0, 0] },
    fields: ["pos"],
    footprint: () => ({ x: 1, z: 1 }),
  },
  moveHole: {
    op: "moveHole",
    label: "Hole (canvas)",
    color: "var(--hole)",
    singleton: true,
    defaults: { pos: [0, 0, 8] },
    fields: ["pos"],
    footprint: () => ({ x: 0.6, z: 0.6 }),
  },
  spawnHole: {
    op: "spawnHole",
    label: "+ Extra Hole",
    color: "var(--hole)",
    defaults: { pos: [6, 0, 8] },
    fields: ["pos"],
    footprint: () => ({ x: 0.6, z: 0.6 }),
  },
  spawnCube: {
    op: "spawnCube",
    label: "+ Cube / Wall",
    color: "var(--cube)",
    defaults: { pos: [3, 1, 4], scale: [1, 2, 3], rotY: 0, terrainLayer: "" },
    fields: ["pos", "scale", "rotY", "terrainLayer"],
    footprint: (item) => ({ x: Math.abs(item.scale[0]), z: Math.abs(item.scale[2]) }),
  },
  spawnPlane: {
    op: "spawnPlane",
    label: "+ Plane / Floor",
    color: "var(--plane)",
    defaults: { pos: [0, -1, 0], scale: [5, 1, 5], rotY: 0, terrainLayer: "Fairway" },
    fields: ["pos", "scale", "rotY", "terrainLayer"],
    footprint: (item) => ({ x: Math.abs(item.scale[0]) * 10, z: Math.abs(item.scale[2]) * 10 }),
  },
  spawnAsset: {
    op: "spawnAsset",
    label: "+ Game asset",
    color: "var(--asset)",
    defaults: { pos: [2, 0, 2], scale: [1, 1, 1], rotY: 0, assetId: "" },
    fields: ["pos", "scale", "rotY", "assetId"],
    // Footprint unknown without the catalog's bounds, so fall back to a 2m square marker.
    footprint: () => ({ x: 1.5, z: 1.5 }),
  },
};

// Order for palette display. `spawnAsset` is special-cased by palette.js because it
// opens a catalog picker instead of inserting a default item.
export const PALETTE_ORDER = ["spawnHole", "spawnCube", "spawnPlane", "spawnAsset"];

// Game terrain layers — must mirror the TerrainLayer enum in the plugin. "" = leave as-is
// (no TerrainAddition component attached; inherits whatever the collider's default is).
// Keep ordering natural-for-authoring: playable surfaces first, hazards next, themed variants last.
export const TERRAIN_LAYERS = [
  { id: "",            label: "(default / no override)" },
  { id: "Fairway",     label: "Fairway" },
  { id: "Green",       label: "Green" },
  { id: "Rough",       label: "Rough" },
  { id: "Sand",        label: "Sand" },
  { id: "DirtPath",    label: "Dirt Path" },
  { id: "OutOfBounds", label: "Out of Bounds (kill)" },
  { id: "Ice",         label: "Ice" },
  { id: "BreakableIce", label: "Breakable Ice" },
  // Themed variants — authors who want consistent looks per biome.
  { id: "DryFairway",       label: "Dry Fairway" },
  { id: "DryGreen",         label: "Dry Green" },
  { id: "SandRough",        label: "Sand Rough" },
  { id: "SandOutOfBounds",  label: "Sand OOB" },
  { id: "DesertSand",       label: "Desert Sand" },
  { id: "SnowFairway",      label: "Snow Fairway" },
  { id: "SnowGreen",        label: "Snow Green" },
  { id: "SnowRough",        label: "Snow Rough" },
  { id: "SnowOutOfBounds",  label: "Snow OOB" },
];

// Vanilla hole scenes usable as a canvas. The framework loads the named HoleData's scene as
// the base and then replays our build ops. Keep this list in sync with the framework's
// known-good canvas list as the game adds new courses.
export const CANVASES = [
  { id: "Coast/TwinBeach",   label: "Coast — Twin Beach" },
  { id: "Coast/LongBeach",   label: "Coast — Long Beach" },
  { id: "Coast/Cove",        label: "Coast — Cove" },
  { id: "Coast/RollingHills", label: "Coast — Rolling Hills" },
  { id: "Coast/Downhill",    label: "Coast — Downhill" },
  { id: "Coast/Sandbanks",   label: "Coast — Sandbanks" },
];

// The framework version that understands SCHEMA_VERSION 1. Becomes the dependency in manifest.json.
export const FRAMEWORK_DEPENDENCY = "Cray-SBGMapFramework-0.1.0";
