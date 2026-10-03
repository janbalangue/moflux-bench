"""Opt-in scheduler observation, injected only into the measured Metal process.

No scheduler selection, policy changes, prompts, tokens, or credentials. The
import hook observes the base Scheduler, including calls made by AsyncScheduler.
Missing hooks or incompatible runtimes leave the experiment inconclusive.
"""
import hashlib
import importlib.abc
import importlib.machinery
import json
import os
import re
import sys
import time

TARGET = "vllm.v1.core.sched.scheduler"
OUTPUT = os.environ.get("MOFLUX_BACKEND_EVENTS")
BURST_RECOVERY = os.environ.get("MOFLUX_BURST_RECOVERY") == "true"
# vLLM wraps the body's request_id as chatcmpl-<id>-<8 hex>. Stop at the first
# attempt suffix: a hex tail such as "a0173829" must not be read as the attempt.
BENCH_ID = re.compile(r"moflux-bench-(?:interactive|batch)-[A-Za-z0-9_-]+?-a[0-9]+(?=-|$)")


def install(module):
    cls = module.Scheduler
    schedule = cls.schedule
    add_request = cls.add_request
    epoch = time.time_ns() / 1e6
    origin = time.monotonic_ns() / 1e6
    last_sample = [float("-inf")]
    seen = set()
    fd = os.open(OUTPUT, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)

    def emit(event, **fields):
        # Wall time is the clock the harness samples grants with on this host,
        # so events need no cross-process mapping. clockErrorMs is wall-clock
        # slew since install; the analysis gates its change inside the window.
        now = time.monotonic_ns() / 1e6
        wall = time.time_ns() / 1e6
        row = dict(event=event, atEpochMs=wall, monotonicMs=now,
                   clockErrorMs=wall - (epoch + now - origin),
                   pid=os.getpid(), **fields)
        data = (json.dumps(row, separators=(",", ":")) + "\n").encode()
        if os.write(fd, data) != len(data):
            raise RuntimeError("Incomplete backend observation write")

    def bench_id(request_id):
        match = BENCH_ID.search(request_id)
        return match.group(0) if match else None

    def observed_add(self, request, *args, **kwargs):
        result = add_request(self, request, *args, **kwargs)
        rid = bench_id(request.request_id)
        if rid:
            emit("enqueued", requestId=rid)
        return result

    def observed_schedule(self, *args, **kwargs):
        # Observe pressure before allocations/reclamation in this step.
        now = time.monotonic_ns() / 1e6
        if now - last_sample[0] >= 100:
            identities = {}
            if BURST_RECOVERY:
                identities = dict(
                    runningRequestIds=[rid for request in self.running
                                       if (rid := bench_id(request.request_id))],
                    waitingRequestIds=[rid for request in self.waiting
                                       if (rid := bench_id(request.request_id))])
            emit("pressure", **identities, kvUsage=self.kv_cache_manager.usage,
                 running=len(self.running), waiting=len(self.waiting))
            last_sample[0] = now
        result = schedule(self, *args, **kwargs)
        for request_id, tokens in result.num_scheduled_tokens.items():
            rid = bench_id(request_id)
            if rid and rid not in seen and tokens > 0:
                seen.add(rid)
                emit("first_scheduled", requestId=rid, scheduledTokens=tokens,
                     kvUsage=self.kv_cache_manager.usage)
        return result

    cls.add_request = observed_add
    cls.schedule = observed_schedule
    with open(module.__file__, "rb") as source:
        digest = hashlib.sha256(source.read()).hexdigest()
    emit("installed", schemaVersion=3 if BURST_RECOVERY else 2, clockBasis="realtime", schedulerSourceSha256=digest)


class ObserverLoader(importlib.abc.Loader):
    def __init__(self, wrapped):
        self.wrapped = wrapped

    def create_module(self, spec):
        return self.wrapped.create_module(spec)

    def exec_module(self, module):
        self.wrapped.exec_module(module)
        install(module)


class ObserverFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path, target=None):
        if fullname != TARGET:
            return None
        spec = importlib.machinery.PathFinder.find_spec(fullname, path)
        if spec and spec.loader:
            spec.loader = ObserverLoader(spec.loader)
        return spec


if OUTPUT:
    sys.meta_path.insert(0, ObserverFinder())
