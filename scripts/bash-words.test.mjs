// Differential test of the guard's word reader against real bash (#32, #33, #34): every static word must read as the exact
// bytes bash gives it, or be unreadable (lit null), never a different readable value. A word with an expansion must never
// read as a plain literal: unreadable, or flagged as a glob or brace word.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { parseShell } from "../hooks/guard.mjs";

// s: static (lit compared), ~: tilde (exp compared, HOME=/h), x: an expansion (lit null or glob).
const WORDS = [
  // plain words and backslash escapes
  ["abc", "s"], ["-f", "s"], ["--force", "s"], ["+main", "s"], ["--", "s"], ["a=b", "s"], ["HEAD@1", "s"], ["a#b", "s"], ["x%y", "s"],
  ["a,b", "s"], ["a}b", "s"], ["{}", "s"], ["{a}", "s"], ["x{a,b", "s"], ["{a.b}", "s"], ["{'a,b'}", "s"], ["{a\\,b}", "s"], ["{1'..'3}", "s"], ["!", "s"], ["}", "s"], ["é", "s"], ["\\-f", "s"], ["\\\\", "s"], ["\\$x", "s"], ["\\*", "s"], ["\\{a,b\\}", "s"],
  ["a\\ b", "s"], ["\\'", "s"], ['\\"', "s"], ["\\~", "s"], ["a\\\nb", "s"], ["a\\", "s"],
  // single and double quotes
  ["''", "s"], ["'a b'", "s"], ["'$x'", "s"], ["'\\n'", "s"], ["'\"'", "s"], ["'{a,b}'", "s"], ["'*'", "s"], ["'~'", "s"],
  ['""', "s"], ['"a b"', "s"], ['"\\$x"', "s"], ['"\\\\"', "s"], ['"\\""', "s"], ['"\\a"', "s"], ['"a\\`b"', "s"], ['"\'"', "s"], ['"*"', "s"],
  ['"{a,b}"', "s"], ['"~"', "s"], ['"$"', "s"], ['"a$"', "s"], ['"$\'x\'"', "s"], ['"a\\\nb"', "s"], ['"\\\'"', "s"],
  // ANSI-C $'...'
  ["$'a'", "s"], ["$''", "s"], ["$'\\n'", "s"], ["$'\\t'", "s"], ["$'\\a'", "s"], ["$'\\b'", "s"], ["$'\\e'", "s"], ["$'\\E'", "s"], ["$'\\f'", "s"],
  ["$'\\r'", "s"], ["$'\\v'", "s"], ["$'\\\\'", "s"], ["$'\\''", "s"], ["$'\\\"'", "s"], ["$'\\?'", "s"], ["$'\\z'", "s"], ["$'\\x2d'", "s"],
  ["$'\\x2df'", "s"], ["$'\\x'", "s"], ["$'\\xg'", "s"], ["$'\\x41b'", "s"], ["$'\\101'", "s"], ["$'\\0'x", "s"], ["$'a\\0b'", "s"], ["$'\\053'", "s"],
  ["$'\\400'", "s"], ["$'\\777'", "s"], ["$'\\8'", "s"], ["$'\\xff'", "s"], ["$'\\u002b'", "s"], ["$'\\u'", "s"], ["$'\\u00e9'", "s"], ["$'\\U0000002B'", "s"],
  ["$'\\U41'", "s"], ["$'\\U110000'", "s"], ["$'\\Uffffffff'", "s"], ["$'\\cA'", "s"], ["$'\\ca'", "s"], ["$'\\c?'", "s"], ["$'\\c@'", "s"], ["$'\\c['", "s"],
  ["$'\\c1'", "s"], ["$'\\c\"'", "s"], ["$'\\c\\\\'", "s"], ["$'\\c\\\\x'", "s"], ["$'\\c\\x'", "s"], ["$'a\\c'", "s"], ["$'\\c'", "s"],
  // locale $"..." and $ edges
  ['$"-f"', "s"], ['$""', "s"], ['$"a b"', "s"], ['$"\\$x"', "s"], ['a$"b"', "s"], ["$", "s"], ["a$", "s"], ["$/", "s"], ["$=", "s"], ["$,", "s"],
  // mixed adjacent quoting
  ["a'b'\"c\"$'d'", "s"], ["'a'\\''b'", "s"], ["\"a\"'b'", "s"], ["--force'-with-lease'", "s"], ['+"main"', "s"], ['-"f"', "s"], ["''-f", "s"], ["$'\\x2d'f", "s"],
  // tilde
  ["~", "~"], ["~/a", "~"], ["~/", "~"], ["a~", "s"], ["~\"x\"", "s"], ["x:~/a", "s"], ["--t=~/x", "s"], ["~root", "~"], ["~+", "~"], ["a=~/x", "~"], ["a=b:~/x", "~"],
  ["a+=~/x", "~"], ["a=:~", "~"], ["a=\"b\":~/x", "~"], ["a=b=~/x", "s"], ["a=b\\:~/x", "s"], ["a='b:'~/x", "s"], ["a\\=~/x", "s"], ["a=b\\\\:~/x", "~"],
  // expansions
  ["$x", "x"], ["${x}", "x"], ["$HOME", "x"], ["${x:-y}", "x"], ["$(echo a)", "x"], ["`echo a`", "x"], ["$((1+1))", "x"], ["$[1+1]", "x"], ["$1", "x"],
  ["$@", "x"], ["$?", "x"], ["$$", "x"], ['"$x"', "x"], ['"${x}"', "x"], ['"$(echo)"', "x"], ['$"$x"', "x"], ["*", "x"], ["a*", "x"], ["?", "x"],
  ["[ab]", "x"], ["{a,b}", "x"], ["a{b,c}", "x"], ["{1..3}", "x"], ["$'\\x2d'{f,}", "x"], ['"a"*', "x"], ["{,}", "x"], ["{{a,b}", "x"], ["{a,{b}}", "x"],
  // substitutions inside ${...}, $((...)) and $[...] (#36)
  ["${x:-$(echo a)}", "x"], ["${x:-`echo a`}", "x"], ["${x:-$(echo })}", "x"], ['"${x:-$(echo a)}"', "x"], ["${x:=b}", "x"], ["${#x}", "x"], ["${x/a/b}", "x"],
  ['"$\\\n(echo a)"', "x"], ['"$\\\n{x}"', "x"], ['"${x:-$\\\n(echo a)}"', "x"], ["`echo \\\na`", "x"], ["$\\\nx", "x"],
  // $(( without a closing )) is $( and a subshell; $\<newline>'..' and $\<newline>".." (#37)
  ["$((echo a) )", "x"], ["$(\\\n(echo a) )", "x"], ["$\\\n((echo a) )", "x"], ['"$((echo a) )"', "x"], ["$\\\n'-f'", "s"], ['$\\\n"-f"', "s"], ["$\\\n'\\x2d'f", "s"],
  ["$((1+$(echo 1)))", "x"], ["$(((1+2)*3))", "x"], ["$((`echo 1`+1))", "x"], ["$[1+$(echo 1)]", "x"], ["$[x]", "x"],
];

const HOME = "/h";
const bashSkip = spawnSync("bash", ["--version"]).error ? "bash is not installed" : false;
const read = (word) => {
  const cmds = parseShell(`printf "%s\\0" ${word}`, { HOME }).filter((c) => c.depth === 0);   // a substitution adds its own
  assert.equal(cmds.length, 1, `${JSON.stringify(word)}: one command`);
  assert.equal(cmds[0].words.length, 3, `${JSON.stringify(word)}: one word`);
  return cmds[0].words[2];
};

test("the guard reads every word as bash does, or as unreadable; an expansion never reads as a plain literal", { skip: bashSkip }, () => {
  const bad = [];
  for (const [word, kind] of WORDS) {
    const w = read(word);
    if (kind === "x") { if (w.lit !== null && !w.glob) bad.push(`${JSON.stringify(word)}: an expansion read as ${JSON.stringify(w.lit)}`); continue; }
    const got = kind === "~" ? w.exp : w.lit;
    if (kind === "~" && got !== null && got === w.lit) bad.push(`${JSON.stringify(word)}: a tilde read as a plain literal`);
    if (got === null) continue;
    const want = execFileSync("bash", ["-c", `printf "%s\\0" ${word}`], { env: { HOME } });
    if (!Buffer.from(`${got}\0`).equals(want)) bad.push(`${JSON.stringify(word)}: guard ${JSON.stringify(got)}, bash ${JSON.stringify(want.toString("latin1"))}`);
  }
  assert.deepEqual(bad, []);
});
