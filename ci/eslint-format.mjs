// eslint formatter: one `path:line:col rule: message` line per finding (eslint 9 dropped the built-in unix format).
export default function format(results) {
  return results.flatMap((r) => r.messages.map((m) => `${r.filePath}:${m.line}:${m.column} ${m.ruleId ?? "parse"}: ${m.message}`)).join("\n");
}
