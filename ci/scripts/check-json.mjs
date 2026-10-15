// Fails (path:1 message) for every file given that is not valid JSON.
import { readFileSync } from "node:fs";
let bad = 0;
for (const f of process.argv.slice(2)) {
  try { JSON.parse(readFileSync(f, "utf8")); } catch (e) { bad++; console.log(`${f}:1 invalid JSON: ${e.message}`); }
}
process.exit(bad ? 1 : 0);
