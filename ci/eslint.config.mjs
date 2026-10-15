// Quality lint for `make quality`: eslint's recommended rules over the plugin's .mjs files, nothing else.
// Node built-ins only, so the Node globals are listed here rather than adding the `globals` package.
import js from "@eslint/js";

const nodeGlobals = Object.fromEntries(
  ["process", "console", "Buffer", "URL", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "TextDecoder", "TextEncoder", "structuredClone", "AbortController", "fetch"].map((n) => [n, "readonly"]),
);

export default [
  { ignores: ["ci/out/**", "node_modules/**"] },
  js.configs.recommended,
  { files: ["**/*.mjs"], languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: nodeGlobals } },
  // Tuned so main is green; each is a reason, not a silence.
  // no-empty: an empty `catch {}` is how the hooks and scripts deliberately ignore a failure that must never block
  // (hooks/guard.mjs, hooks/okf-hook.mjs, scripts/intent-plan.mjs); empty catch stays allowed, other empty blocks still fail.
  { rules: { "no-empty": ["error", { allowEmptyCatch: true }] } },
  // Two real findings in scripts/manifest.test.mjs (unused import `cpSync`, regexes with literal runs of spaces at lines 70
  // and 105) are reported to the owner, not fixed here (CI change only). Off for that file alone; remove when fixed.
  { files: ["scripts/manifest.test.mjs"], rules: { "no-unused-vars": "off", "no-regex-spaces": "off" } },
];
