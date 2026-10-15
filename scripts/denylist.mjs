// Names that must not appear in the public fixtures and scenarios (project, host, user and lab names). Stored as SHA-256 of
// the lower-case word so this public file does not spell them (#2). A word inside a longer word is not caught.
import { createHash } from "node:crypto";

const DENIED = new Set([
  "0e6a8e0b849ed9b064c5a25e1ee5592f427e3eb9d250e42069ce46147d00e8d4",
  "09c4b6ea5306c3b908dedb4217e413a49e4910f9ba425551fa6a8cb9e68cbd7a",
  "5b39bfccb1447d4aae30e7a4fb0f4ba37e79ea96ec54b5ba7223979a15e4d0ae",
  "fa090a00fc06d8e115c4a166eccb651a7b581fe5d58f2301093902ed318d2ccb",
  "86bd33ebf64e01aaafb7dab419436ac025d04abd933bbbb124ddb25c30b59dd7",
  "a51146d38077ff992eba84cf1d5e9b249073503eb74868699016153b031a38f7",
]);
const sha = (w) => createHash("sha256").update(w).digest("hex");

// The first denied word of `text` (as an 8-hex hash prefix), or a `/home/` path; null when clean.
export function denied(text) {
  if (/\/home\//.test(text)) return "/home/ path";
  for (const w of new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))) if (DENIED.has(sha(w))) return sha(w).slice(0, 8);
  return null;
}
