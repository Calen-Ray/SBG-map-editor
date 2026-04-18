// Left panel: palette of addable primitives. Reads from OPS/PALETTE_ORDER in schema.js
// and dispatches to state.addItem on click. `spawnAsset` opens an asset picker instead
// of inserting a default — you can't place "a game asset" without choosing which one.

import { OPS, PALETTE_ORDER } from "./schema.js";
import { addItem, updateItem } from "./state.js";
import { openAssetPicker } from "./asset-picker.js";

export function mountPalette(root) {
  for (const key of PALETTE_ORDER) {
    const spec = OPS[key];
    if (!spec || spec.singleton) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = `<span class="dot" style="background:${spec.color}"></span>${spec.label}`;
    btn.addEventListener("click", async () => {
      if (key === "spawnAsset") {
        const pick = await openAssetPicker();
        if (!pick) return;
        const uid = addItem("spawnAsset");
        if (uid) updateItem(uid, { assetId: pick.id });
      } else {
        addItem(key);
      }
    });
    root.appendChild(btn);
  }
}
