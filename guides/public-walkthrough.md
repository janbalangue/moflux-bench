# Public research walkthrough

The public arms do not require Tyr or Latchflo:

```bash
npm run verify
npm run demo:full
```

`demo:full` starts and validates its telemetry relay, Prometheus, Grafana, and
Redis services before the first narrated phase. It waits for the provisioned
`moflux-bench` dashboard and opens its direct URL automatically. Use
`node demo/run-demo.mjs --step --no-open-grafana` for headless runs. Pass
`--no-stack-start` only when the support services are already managed
externally. External or test-managed services can be selected with
`--telemetry-relay-url`, `--prometheus-url`, and `--grafana`; the normal
defaults remain ports 8200, 9090, and 3000. A failed startup includes Compose
status plus telemetry-relay and Grafana logs instead of reporting only that
port 8200 was unhealthy.

Requires Node 22+ and Docker Compose v2. There are no runtime npm dependencies —
the Redis client is a small RESP implementation in `arms/redis-client.mjs`.

## Host processes and their ports

The provider simulator, the four replicas, and the load generator run on the
host rather than in Compose, because the demo kills a replica mid-run and doing
that through the host process tree is far less fragile than through Docker. The
consequence is that `npm run demo:down` cannot clean them up: it stops
containers, and these are not containers.

The simulator needs TCP **9000**, and the preflight refuses to start if
something else already holds it. If a run was interrupted hard enough that the
presenter could not run its own cleanup, find the survivor with:

```bash
lsof -nP -iTCP:9000 -sTCP:LISTEN
```

A host process that fails to start is reported with the exit code or signal
that ended it, how long the wait lasted, whether the process was still running
at that point, and its own last output. Startup failures that produce no output
say so explicitly, so silence is never confused with a missing check.
