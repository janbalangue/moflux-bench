"""Regression for the observer without importing vLLM or allocating a model."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
from types import SimpleNamespace

output = Path(sys.argv[1]) / "events.jsonl"
os.environ["MOFLUX_BACKEND_EVENTS"] = str(output)
spec = importlib.util.spec_from_file_location("probe", Path(__file__).with_name("sitecustomize.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

class Scheduler:
    def __init__(self):
        self.kv_cache_manager = SimpleNamespace(usage=0.95)
        self.running = []
        self.waiting = []
        self.result = SimpleNamespace(num_scheduled_tokens={})

    def add_request(self, request):
        self.waiting.append(request)
        return 42

    def schedule(self, throttle_prefills=False):
        return self.result

for engine_id, bench_id in [
    ("chatcmpl-moflux-bench-batch-2-a1-a0173829", "moflux-bench-batch-2-a1"),
    ("chatcmpl-moflux-bench-interactive-resume-1-a12-a906bc1f", "moflux-bench-interactive-resume-1-a12"),
    ("moflux-bench-batch-pressure-3-a1", "moflux-bench-batch-pressure-3-a1"),
]:
    match = probe.BENCH_ID.search(engine_id)
    assert match and match.group(0) == bench_id, (engine_id, match and match.group(0))

probe.install(SimpleNamespace(Scheduler=Scheduler, __file__=__file__))
scheduler = Scheduler()
rid = "chatcmpl-moflux-bench-interactive-1-a1-a8f3bc21"
assert scheduler.add_request(SimpleNamespace(request_id=rid)) == 42
scheduler.result.num_scheduled_tokens = {rid: 0}
scheduler.schedule()
scheduler.result.num_scheduled_tokens = {rid: 12}
assert scheduler.schedule(throttle_prefills=True) is scheduler.result
scheduler.schedule()
rows = [json.loads(line) for line in output.read_text().splitlines()]
assert [r["event"] for r in rows] == ["installed", "enqueued", "pressure", "first_scheduled"]
assert rows[0]["schemaVersion"] == 2 and rows[0]["clockBasis"] == "realtime"
assert rows[1]["requestId"] == rows[-1]["requestId"] == "moflux-bench-interactive-1-a1"
assert rows[-1]["scheduledTokens"] == 12
assert rows[-1]["atEpochMs"] >= rows[1]["atEpochMs"]
# Events carry the shared wall clock directly, not a startup-mapped monotonic.
assert abs(rows[-1]["atEpochMs"] - time.time_ns() / 1e6) < 1000
assert abs(rows[-1]["clockErrorMs"]) < 5
