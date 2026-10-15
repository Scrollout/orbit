// Reads the PostToolUse event from stdin; validates when the edited file is inside the repo's OKF bundle.
// Exit 0 = nothing to say; exit 2 = validator problems on stderr, shown to Claude.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

let event = {};
try { event = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
const file = event.tool_input?.file_path;
if (!file) process.exit(0);
const root = resolve(event.cwd ?? process.cwd());
let bundle = "docs/okf";
try { bundle = JSON.parse(readFileSync(join(root, ".agents/okf.json"), "utf8")).bundle ?? bundle; } catch { /* no or unreadable .agents/okf.json: keep the default bundle; the hook must never block */ }
const bundleDir = resolve(root, bundle);
const rel = relative(bundleDir, resolve(root, file));
if (!existsSync(bundleDir) || rel.startsWith("..") || !rel.endsWith(".md")) process.exit(0);
const r = spawnSync("node", [join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "validate-okf.mjs"), "--root", root], { encoding: "utf8" });
if (r.status === 0) process.exit(0);
process.stderr.write(`OKF docs check failed after editing ${file}:\n${r.stderr || r.stdout}`);
process.exit(2);
