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
  // Findings still in the plugin are listed per file in ci/eslint-baseline.json; an entry that stops matching fails the check.
];
