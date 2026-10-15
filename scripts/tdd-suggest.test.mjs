import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { suggestTdd } from "./tdd-suggest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const base = { targetedTest: "make test-one PKG={pkg}", files: ["src/cart.go", "src/cart_test.go"], sec: "no", door: "no", proof: ["TestCartTotal"], repoHasTests: true };
const s = (o) => suggestTdd({ ...base, ...o });

test("yes: code touched, a proof test named, a targeted-test command and tests present", () => {
  assert.deepEqual(s({}), { tdd: true, reason: "touches production code and names a proof test" });
});

test("security path or one-way door pushes yes without a named proof test", () => {
  assert.deepEqual(s({ proof: [], sec: "yes" }), { tdd: true, reason: "security path or one-way door" });
  assert.deepEqual(s({ proof: [], door: "yes" }), { tdd: true, reason: "security path or one-way door" });
});

test("no: missing command, no tests, docs or config only, nothing to go on (unclear)", () => {
  assert.equal(s({ targetedTest: undefined }).reason, "no targeted-test command in the profile");
  assert.equal(s({ targetedTest: "TODO" }).tdd, false);
  assert.equal(s({ repoHasTests: false, files: ["src/cart.go"] }).reason, "no tests in the repo or the change");
  assert.deepEqual(s({ files: ["docs/a.md", "README.md", ".github/workflows/ci.yml", "config/app.yaml"], sec: "yes" }), { tdd: false, reason: "docs or config only" });
  assert.equal(s({ files: [] }).reason, "unclear: no changed files");
  assert.deepEqual(s({ proof: [] }), { tdd: false, reason: "unclear: no proof test named" });
});

test("cli: prints tdd and the reason; repeated --proof; bad usage 64", () => {
  const root = mkdtempSync(join(tmpdir(), "ts-"));
  mkdirSync(join(root, ".agents"));
  const prof = readFileSync(join(here, "fixtures", "real-profile.md"), "utf8").replace(/^(ci_policy: .*)$/m, "$1\ntdd: auto\ntargeted_test: make test-one PKG={pkg}");
  writeFileSync(join(root, ".agents", "project.md"), prof);
  const run = (...a) => spawnSync("node", [join(here, "tdd-suggest.mjs"), "--root", root, ...a], { encoding: "utf8" });
  const yes = run("--files", "src/cart.go,src/cart_test.go", "--lines", "sec=no,door=no", "--proof", "TestCartTotal", "--proof", "TestCartEmpty");
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /^tdd: yes\nreason: touches production code and names a proof test$/m);
  assert.match(run("--files", "docs/a.md").stdout, /^tdd: no\nreason: docs or config only$/m);
  assert.equal(run().status, 64);
  rmSync(root, { recursive: true, force: true });
});
