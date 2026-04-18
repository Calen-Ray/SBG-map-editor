// Validation rules for export + the UI banner that displays them. Kept separate from export.js
// so other consumers (e.g. a live-as-you-type lint) can subscribe.

import { getState, subscribe } from "./state.js";

// Rule is (state) => error-string-or-null. Add rules here; the banner picks them up.
//
// Thunderstore's local-import path parses the zip filename as <Author>-<Name>-<Version>.zip
// by splitting on '-'. Hyphens inside the id or author break that parse and the package
// installs as "Unknown-*". So id/author must be alphanumeric + underscore only, matching
// Thunderstore's package-name rules exactly.
const TS_NAME = /^[A-Za-z0-9_]+$/;

const RULES = [
  (s) => TS_NAME.test(s.id)     ? null : "ID must be alphanumeric + underscore only (no dashes or spaces). Example: my_first_map",
  (s) => TS_NAME.test(s.author) ? null : "Author must be alphanumeric + underscore only. Example: Cray or jane_doe",
  (s) => s.displayName.trim()   ? null : "Display name is required.",
  (s) => /^\d+\.\d+\.\d+$/.test(s.version) ? null : "Version must be semver (e.g. 0.1.0).",
];

export function validate() {
  const s = getState();
  const errors = [];
  for (const rule of RULES) {
    const msg = rule(s);
    if (msg) errors.push(msg);
  }
  return errors;
}

// Mounts a banner under the top bar. Shown only when there are errors and re-rendered on
// every state change. Caller passes the host element.
export function mountValidationBanner(host) {
  const render = () => {
    const errors = validate();
    if (errors.length === 0) {
      host.classList.add("hidden");
      host.innerHTML = "";
      return;
    }
    host.classList.remove("hidden");
    host.innerHTML = `
      <div class="validation-title">Fix before exporting (${errors.length}):</div>
      <ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>
    `;
  };
  subscribe(render);
  render();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
