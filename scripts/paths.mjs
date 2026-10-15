// Classifies a changed path as test, docs, config or code (production code), by name only. Zero dependencies.
// Used by proof-check.mjs and audit-ledger.mjs (an all-exempt coder report on a step that touches code) and tdd-suggest.mjs.
const TEST = [/(^|\/)(tests?|__tests__|specs?)\//, /(_test\.go|_test\.py|_spec\.rb|\.(test|spec)\.[cm]?[jt]sx?)$/, /(^|\/)test_[^/]*\.py$/];
const DOCS = [/\.(md|mdx|txt|rst|adoc)$/i, /(^|\/)docs?\//, /(^|\/)(LICENSE|NOTICE|AUTHORS)[^/]*$/];
const CONFIG = [/\.(ya?ml|json|toml|ini|cfg|conf|lock|editorconfig)$/i, /(^|\/)\.[^/]+$/, /(^|\/)\.github\//];
export function classify(path) {
  const p = String(path);
  if (TEST.some((r) => r.test(p))) return "test";
  if (DOCS.some((r) => r.test(p))) return "docs";
  if (CONFIG.some((r) => r.test(p))) return "config";
  return "code";
}
export const codeFiles = (files) => (files ?? []).filter((f) => classify(f) === "code");
