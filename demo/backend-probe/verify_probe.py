"""Regression for the observer without importing vLLM or allocating a model."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace

if len(sys.argv) == 2:
    # Isolate the daemon heartbeat and observer environment between protocols.
    for mode in ("standard", "v3", "v4"):
        subprocess.run([sys.executable, __file__, sys.argv[1], mode], check=True)
    sys.exit(0)

mode = sys.argv[2]
output = Path(sys.argv[1]) / f"events-{mode}.jsonl"
output.unlink(missing_ok=True)
os.environ["MOFLUX_BACKEND_EVENTS"] = str(output)
os.environ["MOFLUX_BURST_RECOVERY"] = "false" if mode == "standard" else "true"
os.environ["MOFLUX_BURST_PROTOCOL"] = f"burst-recovery-{mode}" if mode != "standard" else ""
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
if mode == "v4":
    # No scheduler activity: the independent heartbeat must keep sampling.
    time.sleep(0.55)
rows = [json.loads(line) for line in output.read_text().splitlines()]
events = [row for row in rows if row["event"] != "clock"]
assert [r["event"] for r in events] == ["installed", "enqueued", "pressure", "first_scheduled"]
assert events[0]["schemaVersion"] == {"standard": 2, "v3": 3, "v4": 4}[mode]
assert events[0]["clockBasis"] == "realtime"
assert events[1]["requestId"] == events[-1]["requestId"] == "moflux-bench-interactive-1-a1"
assert events[-1]["scheduledTokens"] == 12
assert events[-1]["atEpochMs"] >= events[1]["atEpochMs"]
# Events carry the shared wall clock directly, not a startup-mapped monotonic.
assert abs(rows[-1]["atEpochMs"] - time.time_ns() / 1e6) < 1000
assert abs(rows[-1]["clockErrorMs"]) < 5
if mode == "standard":
    assert "runningRequestIds" not in events[2]
else:
    assert events[2]["runningRequestIds"] == []
    assert events[2]["waitingRequestIds"] == ["moflux-bench-interactive-1-a1"]
if mode == "v4":
    clocks = [row for row in rows if row["event"] == "clock"]
    assert len(clocks) >= 3
    assert all(0 <= row["clockReadSpanMs"] < 100 for row in rows)
    assert all(a["monotonicMs"] <= b["monotonicMs"] for a, b in zip(rows, rows[1:]))
    assert clocks[-1]["monotonicMs"] - clocks[0]["monotonicMs"] >= 450
else:
    assert all("clockReadSpanMs" not in row for row in rows)
    assert not any(row["event"] == "clock" for row in rows)
