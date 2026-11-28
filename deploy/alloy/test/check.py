"""Reads the receiver's debug output (stdin) and checks travel_agent.llm.tokens."""

import re
import sys

text = sys.stdin.read()
expected = {
    ("travel-agent-langgraph", "input"): 128, ("travel-agent-langgraph", "output"): 7,
    ("travel-agent-parlant", "input"): 4013, ("travel-agent-parlant", "output"): 88,
    ("travel-agent-inkeep", "input"): 10311, ("travel-agent-inkeep", "output"): 118,
}
got = {}
# The debug exporter prints each ResourceMetrics block, then its data points.
for block in text.split("ResourceMetrics #")[1:]:
    svc = re.search(r"service\.name: Str\(([^)]+)\)", block)
    if not svc or "travel_agent.llm.tokens" not in block:
        continue
    for dp in block.split("NumberDataPoints #")[1:]:
        t = re.search(r"gen_ai\.token\.type: Str\((\w+)\)", dp)
        v = re.search(r"Value: (\d+)", dp)
        if t and v:
            key = (svc.group(1), t.group(1))
            got[key] = max(got.get(key, 0), int(v.group(1)))
bad = {k: (got.get(k), want) for k, want in expected.items() if got.get(k) != want}
extra = sorted(set(got) - set(expected))
if bad or extra:
    print("FAIL", {"mismatched": bad, "unexpected": extra, "got": got})
    sys.exit(1)
print("PASS", got)
