# Fleet membership

Focused current demos validate fleet membership and OpenAI compatibility separately.
The fleet-membership benchmark is entirely local and free:

```bash
npm run demo:membership
```

It repeatedly proves four-member convergence, heartbeat revision stability,
timeout removal, replacement under a new identity/endpoint, topology agreement,
and monotonic revisioning against Latchflo 0.20.1.
