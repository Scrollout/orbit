import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const validate = (root) => spawnSync("node", [join(here, "validate-okf.mjs"), "--root", root], { encoding: "utf8" });

// A fresh okf-init bundle plus one concept `x.md` at the bundle root, listed in the root index with its description.
function bundle(frontmatter, body = "**TL;DR:** A test concept.\n") {
  const root = mkdtempSync(join(tmpdir(), "okf-"));
  spawnSync("node", [join(here, "okf-init.mjs"), "--root", root], { encoding: "utf8" });
  if (frontmatter !== undefined) {
    writeFileSync(join(root, "docs/okf/x.md"), `---\n${frontmatter}\n---\n${body}`);
    appendFileSync(join(root, "docs/okf/index.md"), "* [X](x.md) - A test concept. Load when testing.\n");
  }
  return root;
}
const base = "type: Reference\ntitle: X\ndescription: A test concept.";
function check(frontmatter, body) {
  const root = bundle(frontmatter, body);
  const r = validate(root);
  rmSync(root, { recursive: true, force: true });
  return r;
}
const ok = (r) => assert.equal(r.status, 0, r.stderr);
const fails = (r, re) => { assert.equal(r.status, 1, r.stdout); assert.match(r.stderr, re); };

test("a fresh okf-init bundle passes with no warnings", () => {
  const r = check();
  ok(r);
  assert.doesNotMatch(r.stderr, /warn:/);
});

test("the full trust and provenance families of SPEC §5 pass, flow style", () => {
  const r = check(`${base}
status: stable
generated: { by: reference_agent/gemini-2.5-pro, at: 2026-06-20T22:53:05Z }
verified: { by: human:ahormati, at: 2026-06-25T09:00:00Z }
stale_after: 2026-12-31T00:00:00Z
sources:
  - id: exec-rev-dash
    resource: dashboards/exec-revenue
    title: Executive revenue dashboard
    author: team:finance-fpa
    usage_count: 5000
    last_modified: 2026-06-18T00:00:00Z
usage_window: { from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z }`,
  "**TL;DR:** A test concept, corroborated.[^exec-rev-dash]\n\n[^exec-rev-dash]: Executive revenue dashboard\n");
  ok(r);
  assert.doesNotMatch(r.stderr, /warn:/);
});

test("block style: a verified list, a block-mapping generated, flow-mapping sources with their own usage_window", () => {
  ok(check(`${base}
generated:
  by: process:orbit-okf-init
  at: 2026-06-20T22:53:05Z
verified:
  - { by: human:ahormati, at: 2026-06-25T09:00:00Z }
  - { by: process:finance-nightly, at: 2026-06-26T02:00:00Z }
sources:
  - { id: s1, resource: "https://example.com/a", usage_window: { from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z } }`,
  "**TL;DR:** Cited.[^s1]\n\n[^s1]: A\n"));
});

test("a sources entry without resource fails (SPEC §5.1 REQUIRED)", () => {
  fails(check(`${base}\nsources:\n  - id: s1\n    title: No resource`, "**TL;DR:** Cited.[^s1]\n\n[^s1]: A\n"), /sources entry s1 needs a resource/);
});

test("sources that is not a list fails", () => {
  fails(check(`${base}\nsources: https://example.com/a`), /sources must be a list/);
});

test("last_modified and usage_window bounds need a UTC offset", () => {
  fails(check(`${base}\nsources:\n  - id: s1\n    resource: x\n    last_modified: 2026-06-18`, "**TL;DR:** C.[^s1]\n\n[^s1]: A\n"), /last_modified '2026-06-18'/);
  fails(check(`${base}\nusage_window: { from: 2026-06-01, to: 2026-06-30T00:00:00Z }`), /usage_window\.from '2026-06-01'/);
  fails(check(`${base}\nusage_window: last month`), /usage_window needs \{ from, to \}/);
});

test("generated needs by (SPEC §5.2 REQUIRED); an actor off the convention is only a warning", () => {
  fails(check(`${base}\ngenerated: { at: 2026-06-20T22:53:05Z }`), /generated needs `by`/);
  fails(check(`${base}\ngenerated:`), /generated needs `by`/);
  const r = check(`${base}\ngenerated: { by: gemini, at: 2026-06-20T22:53:05Z }`);
  ok(r);
  assert.match(r.stderr, /warn: .*generated\.by 'gemini' does not follow the actor convention/);
});

test("each verified entry needs by and at; an actor off the convention is only a warning", () => {
  fails(check(`${base}\nverified: { by: human:ahormati }`), /each verified entry needs `by` and `at`/);
  fails(check(`${base}\nverified:\n  - by: human:ahormati`), /each verified entry needs `by` and `at`/);
  const r = check(`${base}\nverified:\n  - { by: ahormati, at: 2026-06-25T09:00:00Z }`);
  ok(r);
  assert.match(r.stderr, /warn: .*verified\.by 'ahormati' does not follow the actor convention/);
});

test("verified in all four shapes passes: flow mapping, block mapping, list of flow mappings, list of block mappings", () => {
  for (const v of [
    "verified: { by: human:a, at: 2026-06-25T09:00:00Z }",
    "verified:\n  by: human:a\n  at: 2026-06-25T09:00:00Z",
    "verified:\n  - { by: human:a, at: 2026-06-25T09:00:00Z }",
    "verified:\n  - by: human:a\n    at: 2026-06-25T09:00:00Z\n  - by: process:nightly\n    at: 2026-06-26T02:00:00Z",
  ]) {
    const r = check(`${base}\n${v}`);
    ok(r);
    assert.doesNotMatch(r.stderr, /warn:/, v);
  }
});

test("a human-verified draft is a warning, not a failure", () => {
  const r = check(`${base}\nstatus: draft\nverified: { by: human:ahormati, at: 2026-06-25T09:00:00Z }`);
  ok(r);
  assert.match(r.stderr, /warn: .*x\.md: status draft means not yet reviewed/);
  assert.doesNotMatch(check(`${base}\nstatus: draft\nverified: { by: process:nightly, at: 2026-06-25T09:00:00Z }`).stderr, /warn:/);
});

test("an index line without the doc's description is a warning (SPEC §8 SHOULD)", () => {
  const r = check(base.replace("A test concept.", "Something else entirely."));
  ok(r);
  assert.match(r.stderr, /warn: .*x\.md: its line in .*index\.md does not carry its description verbatim/);
  assert.doesNotMatch(check(base.replace("A test concept.", "a TEST concept")).stderr, /warn:/);
});

test("conformance: a concept without type fails", () => {
  fails(check("title: X\ndescription: A test concept."), /frontmatter needs a non-empty 'type'/);
});
