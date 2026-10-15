// Security lint for `make security`: eslint-plugin-security's recommended rules over the plugin's .mjs files
// (the JS/shell stand-in for semgrep: no Python stack, and the plugin has no web surface). Suppressions go here, each with a reason.
import security from "eslint-plugin-security";

export default [
  { ignores: ["ci/out/**", "node_modules/**"] },
  security.configs.recommended,
  { files: ["**/*.mjs"], languageOptions: { ecmaVersion: 2024, sourceType: "module" } },
  // Rules off, with reasons (every rule left on fails the build):
  // - detect-non-literal-fs-filename (248 hits): every script is a CLI that reads the paths it is given; noise by design.
  // - detect-object-injection (163 hits): flags every obj[key]; known false-positive-heavy, no signal on this code.
  // detect-unsafe-regex and detect-non-literal-regexp stay on; the sites that trip them today are listed per file in
  // ci/eslint-baseline.json (Scrollout/orbit#3) and a baseline entry that stops matching fails the check.
  { rules: { "security/detect-non-literal-fs-filename": "off", "security/detect-object-injection": "off" } },
];
