#!/usr/bin/env python3
"""Fix the 13 failing acts in R16-p1.jsonl. Every new quote/segment is asserted
against the stored segment text (whitespace-normalized) before writing."""
import json, re

ROOT = "/Users/daniel/Projects/uni.local/master_project/axial_coding"
norm = lambda s: re.sub(r"\s+", " ", s).strip()

segs = {}
for line in open(f"{ROOT}/corpus/segments.jsonl"):
    s = json.loads(line)
    if s.get("report_idx") == "R16":
        segs[s["segment_id"]] = s.get("text", "")

lines = open(f"{ROOT}/coding/acts/R16-p1.jsonl").read().splitlines()

def set_act(n, **kw):
    """Rewrite act on line n (1-indexed); assert quote is verbatim substring of its segment."""
    act = json.loads(lines[n - 1])
    act.update(kw)
    assert act["segment_id"] in segs, f"line {n}: unknown segment {act['segment_id']}"
    assert len(act["quote"]) <= 120, f"line {n}: quote too long ({len(act['quote'])})"
    assert norm(act["quote"]) in norm(segs[act["segment_id"]]), (
        f"line {n}: quote not verbatim in {act['segment_id']}: {act['quote'][:80]!r}")
    lines[n - 1] = json.dumps(act, ensure_ascii=False)

# line 2: R16-003 — re-quote with the backticks that are actually in the stored text
set_act(2, quote='`importScripts("https://storage.googleapis.com/workbox-cdn/releases/4.3.1/workbox-sw.js");`')

# line 4: R16-008 — coder wrote "the" where segment says "a"; re-quote verbatim, trimmed to <=120
set_act(4, quote="`content_security_policy` that includes remote origins (`https://www.google.com`, `https://www.gstatic.com`)")

# line 5: R16-008 — paraphrase; the verbatim sentence is in the same segment
set_act(5, quote="It doesn't seem to use `packages/popup/build/service-worker.js` in the manifest.")

# line 6: R16-012 -> R16-013 (tool_result holds the edit error); trim to <=120 chars
set_act(6, segment_id="R16-013", quote="The oldText must match exactly including all whitespace and newlines.")

# line 7: R16-016 -> R16-017 (tool_result)
set_act(7, segment_id="R16-017")

# line 9: R16-036 — quote the edit reasoning verbatim instead of the generic result string
set_act(9, quote="`service_worker.js:132587`: `eval(obj)` - unreachable. I'll remove it.")

# line 10: R16-039 -> R16-038 (the considered-then-dropped comment lives in the tool_call text)
set_act(10, segment_id="R16-038", quote="// In MV3, new Function is forbidden. We assume callback is a function.")

# line 12: R16-048 -> R16-049 (write tool_result)
set_act(12, segment_id="R16-049")

# line 17: R16-052 -> R16-054 (the load-vs-runtime tradeoff reasoning); trimmed to <=120
set_act(17, segment_id="R16-054", quote="If I replace `new Function` with a dummy, it will load, but it will probably throw errors at runtime")

# line 19: R16-058 — quote the sed command verbatim as stored (with \-escapes)
t58 = segs["R16-058"]
i = t58.find("window\\\\.Buffer")  # raw text contains window\\.Buffer
assert i != -1, "sed needle not found in R16-058"
start = t58.rfind("sed -i", 0, i)
end = t58.find("service_worker.js", i) + len("service_worker.js")
sed_quote = t58[start:end]
set_act(19, quote=sed_quote)

# line 23: R16-050 -> R16-076 (the actual completion claim); trimmed to <=120
set_act(23, segment_id="R16-076", quote="should register without throwing `window is not defined` or CSP errors related to `new Function`.")

# line 24: R16-051 — outcome string is invented; anchor on the no-verification rule instead
set_act(24, quote="do not run any verification yourself")

# line 25: R16-008 -> R16-009 (manifest edit tool_result)
set_act(25, segment_id="R16-009")

open(f"{ROOT}/coding/acts/R16-p1.jsonl", "w").write("\n".join(lines) + "\n")
print("all 13 acts rewritten and asserted verbatim")
