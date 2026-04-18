// Builds a Thunderstore-compatible .zip in the browser and triggers a download.
//
// Layout emitted:
//   <Author>-<id>-<version>.zip
//   ├── manifest.json
//   ├── icon.png
//   ├── README.md
//   └── Maps/<id>/<id>.mapjson
//
// Dependencies listed: Cray-SBGMapFramework-<pinned>. The framework's JSON map loader
// (sibling to the AssetBundle loader) reads Maps/*/*.mapjson and registers one ProceduralMap
// per file.

import JSZip from "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";
import { FRAMEWORK_DEPENDENCY } from "./schema.js";
import { getState, toMapJson } from "./state.js";
import { validate } from "./validation.js";
import { getCustomIconBytes } from "./icon.js";

// Build the zip in memory WITHOUT triggering the download — used by the preview modal so
// we can show byte sizes before committing. Returns { blob, fileName, entries[] }.
export async function buildExportPackage() {
  const st = getState();
  const zip = new JSZip();

  const mapjsonText = JSON.stringify(toMapJson(), null, 2);
  const manifestText = makeManifest(st);
  const readmeText = makeReadme(st);
  const iconBytes = getCustomIconBytes() ?? await makeIconPng(st);

  zip.file("manifest.json", manifestText);
  zip.file("README.md", readmeText);
  zip.file("icon.png", iconBytes, { binary: true });
  // Flat layout: <id>.mapjson at the plugin root. r2modman's "Import local mod" path
  // sometimes strips nested directories when it can't parse the manifest, so keeping the
  // mapjson at the top level makes the package resilient. The framework scanner accepts
  // either root-level or Maps/<id>/ layouts.
  zip.file(`${st.id}.mapjson`, mapjsonText);

  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  const entries = [
    { name: "manifest.json",       size: byteLen(manifestText) },
    { name: "README.md",           size: byteLen(readmeText) },
    { name: "icon.png",            size: iconBytes.byteLength ?? iconBytes.length },
    { name: `${st.id}.mapjson`,    size: byteLen(mapjsonText) },
  ];
  const fileName = `${st.author || "Author"}-${st.id}-${st.version}.zip`;
  return { blob, fileName, entries, totalSize: blob.size };
}

export async function exportZip() {
  const errors = validate();
  if (errors.length) {
    document.getElementById("btn-export")?.animate(
      [{ background: "var(--danger)" }, { background: "var(--accent)" }],
      { duration: 400 },
    );
    return;
  }
  const pkg = await buildExportPackage();
  downloadBlob(pkg.blob, pkg.fileName);
}

function byteLen(str) { return new TextEncoder().encode(str).length; }

function makeManifest(st) {
  // Thunderstore's manifest schema: name, version_number, website_url, description,
  // dependencies. It deliberately does NOT have an `author` field — the author comes from
  // the zip filename `<Author>-<Name>-<Version>.zip` at local import (and from the upload
  // URL on Thunderstore.io itself). We ship author inside a comment-style `__metadata`
  // sibling so tooling that scans the manifest can still recover it.
  const manifest = {
    name: st.id,
    version_number: st.version,
    website_url: "",
    description: (st.description || st.displayName).slice(0, 250),
    dependencies: [FRAMEWORK_DEPENDENCY],
  };
  return JSON.stringify(manifest, null, 2);
}

function makeReadme(st) {
  return `# ${st.displayName}

${st.description || "_No description provided._"}

**Author:** ${st.author}
**Par:** ${st.par} — **Difficulty:** ${st.difficulty}
**Canvas scene:** \`${st.canvas}\`

## Install

Requires [${FRAMEWORK_DEPENDENCY}](https://thunderstore.io/). Install via r2modman; the map
appears under **Community Maps** in the course selector.

## Build ops

\`\`\`json
${JSON.stringify(toMapJson().build, null, 2)}
\`\`\`
`;
}

// Minimal icon.png: render the current 2D canvas view into a 256×256 image. Falls back to a
// solid color block if the viewport canvas hasn't rendered yet.
async function makeIconPng(st) {
  const view = document.getElementById("view2d");
  const out = document.createElement("canvas");
  out.width = 256; out.height = 256;
  const ctx = out.getContext("2d");
  // background
  ctx.fillStyle = "#1b1f24";
  ctx.fillRect(0, 0, 256, 256);
  if (view && view.width && view.height) {
    // letterbox the viewport into the icon
    const srcAspect = view.width / view.height;
    let sw = view.width, sh = view.height, sx = 0, sy = 0;
    if (srcAspect > 1) { sw = view.height; sx = (view.width - sw) / 2; } else { sh = view.width; sy = (view.height - sh) / 2; }
    ctx.drawImage(view, sx, sy, sw, sh, 0, 0, 256, 256);
  }
  // Label strip along the bottom
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 200, 256, 56);
  ctx.fillStyle = "#fff";
  ctx.font = "600 18px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(clamp(st.displayName, 22), 128, 228);
  ctx.font = "12px system-ui";
  ctx.fillStyle = "#cfd3d8";
  ctx.fillText(st.author || "", 128, 248);

  const blob = await new Promise((r) => out.toBlob(r, "image/png"));
  return await blob.arrayBuffer();
}
function clamp(s, n) { return (s && s.length > n) ? s.slice(0, n - 1) + "…" : (s || ""); }

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}
