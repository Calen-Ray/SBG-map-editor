# SBG Map Editor

A lightweight, browser-based map editor for **Super Battle Golf**. Place a tee, a flag, walls,
floors, in-game assets (trees, rocks, props harvested from canvas scenes); hit **Export .zip**;
upload the zip to Thunderstore (or drop into r2modman → "Import Local Mod") and the map shows
up as a playable hole under *Community Maps*.

Static site — no backend, no build step. Plain HTML + ES modules + CSS. Three.js and JSZip are
pulled from a CDN as ESM at runtime.

## Run locally

```
cd map-editor
python -m http.server 8080
# open http://localhost:8080
```

(`file://` won't work — ES modules need an HTTP origin.)

## Deploy

Designed for **GitHub Pages**. Point Pages at the repo root on `main`; `.github/workflows/pages.yml`
handles the upload. No build output directory.

## Controls

| Action | How |
| --- | --- |
| Pan camera (2D) | Left-drag empty space, or Alt+drag |
| Orbit camera (3D) | Right/middle-drag empty space |
| Zoom / dolly | Mouse wheel |
| Select (exclusive) | Click |
| Select (toggle) | Shift+click |
| Marquee select | Shift+drag on empty space |
| Move (single or group) | Drag any selected item |
| Delete (single or selection) | Del / Backspace |
| Duplicate (single or selection) | Ctrl+D |
| Undo / redo | Ctrl+Z · Ctrl+Shift+Z · Ctrl+Y |
| Clear selection | Esc |
| Shortcut help | ? button, or F1 |

Canvas tee and canvas hole are singletons — they can be moved but not deleted.

## Top-bar controls

- **Metadata** — ID, Name, Author, Version, Par, Difficulty, Canvas. **ID** and **Author** must
  be alphanumeric + underscore only (Thunderstore's package-name rules). Ignoring this causes
  r2modman to install as `Unknown-<name>`.
- **Clean canvas** — when checked, the plugin hides decor (trees, houses, terrain) at play
  time so only your spawned geometry and the networked essentials remain.
- **Snap** — drag positions round to this grid step (0.1 / 0.5 / 1 / 2 / off).
- **Samples…** — load a starter map from `samples/`. Includes the current default samples
  (Flat Short, Double Trouble, Wall Maze).
- **Load catalog…** — import the plugin's `BepInEx/cache/sbg-asset-catalog.json` to populate
  the asset picker + show vanilla tee/flag reference ghosts on the selected canvas.
- **Icon…** / **×** — upload a custom 256×256 PNG/JPEG, or clear to auto-generate from the
  viewport.
- **Open…** — load a `.mapjson` or a `.zip` (unpacks `*.mapjson` from inside).
- **Reset** — wipe the editor + autosave.
- **Preview** — show the zip's file list + byte sizes before downloading.
- **Export .zip** — produces a Thunderstore-ready package.
- **2D / 3D** — switch viewports. Shared state, selection, snap; 3D mounts lazily on first click.

Autosave runs on every mutation; the in-progress map survives a page refresh. Drag a `.mapjson`
or previously-exported `.zip` onto the viewport to open it.

## Ops + file format

The `.mapjson` envelope is:

```json
{
  "schema": 1,
  "id": "my_map",
  "displayName": "My Map",
  "author": "Cray",
  "par": 3,
  "difficulty": "Beginner",
  "canvas": "Coast/TwinBeach",
  "description": "...",
  "cleanCanvas": true,
  "build": [
    { "op": "moveTee",   "pos": [0, 0, 0] },
    { "op": "moveHole",  "pos": [0, 0, 10] },
    { "op": "spawnHole", "pos": [4, 0, 10] },
    { "op": "spawnCube", "pos": [2, 1, 5], "scale": [1, 2, 3], "rotY": 45, "terrainLayer": "Rough" },
    { "op": "spawnPlane", "pos": [0, -0.05, 4], "scale": [5, 1, 5], "terrainLayer": "Fairway" },
    { "op": "spawnAsset", "assetId": "Twin Beach/Palm_01", "pos": [6, 0, 3], "rotY": 0, "scale": [1, 1, 1] }
  ]
}
```

Positions are **relative to the canvas tee** (where the player stands). The plugin translates
them to world space at play time.

**Ops:**
- `moveTee` / `moveHole` — teleport the canvas tee / hole.
- `spawnHole` — additional networked hole. Ball physics + scoring work on it.
- `spawnCube` / `spawnPlane` — static geometry. `terrainLayer` drives the ball's rolling
  friction / footstep audio / OOB behavior (Fairway, Green, Rough, Sand, OutOfBounds, Ice, …).
- `spawnAsset` — instantiate a decor asset the plugin has harvested from a canvas you've
  played. `assetId` is the catalog key (`"<scene>/<rootName>[#n]"`).

## Layout

```
map-editor/
├── index.html
├── css/app.css
├── js/
│   ├── main.js            entry, toggles, metadata bindings, uploaders
│   ├── schema.js          OPS, CANVASES, TERRAIN_LAYERS, framework version pin
│   ├── state.js           map store, multi-select, autosave, undo/redo
│   ├── palette.js         left panel (primitive buttons; asset → picker)
│   ├── view2d.js          top-down canvas render + pointer handling + ghosts
│   ├── view3d.js          orbital three.js view (lazy-mounted)
│   ├── inspector.js       right panel (single + multi-select, terrain, asset)
│   ├── import.js          .mapjson / .zip parser + hydrator
│   ├── validation.js      rules + inline banner
│   ├── export.js          JSZip packaging + manifest/icon emit + preview builder
│   ├── icon.js            custom icon upload + persistence
│   ├── asset-catalog.js   parses plugin's sbg-asset-catalog.json
│   └── asset-picker.js    modal that lists catalog entries
├── samples/               starter .mapjson files + index.json
└── README.md
```

## Known limits

- No live test loop — export the zip, drop into r2modman, relaunch.
- Asset picker can only show assets the plugin has already harvested (you have to play a
  canvas once for its props to enter the catalog).
- 3D view's marquee ignores depth (picks by projected screen rect only).
- No Y-rotation in 2D view (numeric in inspector only; 3D lets you visualise it).
- Networked decor (jump pads, breakable ice, dispensers) isn't in the catalog yet — v2 work.

## License

MIT.
