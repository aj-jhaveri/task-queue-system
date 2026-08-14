# task-queue-system

Backend service behind the `/demo/queue` portfolio demo. Deployed on Render against
an Upstash Redis free tier. Branch is `main`.

## Verification before claiming anything works

```bash
npm run typecheck && npm test && npm run build
```

Requires Docker Redis: `docker compose up -d redis`.

Passing this suite is necessary, not sufficient. Report what you actually checked,
not the test count — see `~/.claude/CLAUDE.md` §1–2.

**Node version:** `better-sqlite3` is a native module pinned to a Node major. If
tests fail with `NODE_MODULE_VERSION`, the shell's Node has drifted — run
`npm rebuild better-sqlite3`, or use the Node matching the built binary. CI pins
Node 22 from `.nvmrc`. This is local drift, never a code defect.

**After pushing:** `gh run list --limit 3`. Do not assume CI passed.

**Deploy:** auto-deploy is OFF, so a push does not deploy. Build command must be
exactly `npm ci --include=dev && npm run build && npm prune --omit=dev`.

## The Redis command budget is the central constraint

This service runs on a 500,000 command/month allowance. A previous deployment
consumed ~498,000 in three days. Several values are load-bearing for that budget and
must not be changed casually:

| Setting | Why it matters |
|---|---|
| `WORKER_DRAIN_DELAY_SECONDS=60` | Stock BullMQ default (5s) costs ~1.12M commands/month idle — 225% of cap |
| `WORKER_STALLED_INTERVAL_MS=300000` | Same baseline |
| `DASHBOARD_SNAPSHOT_TTL_MS=900000` | Idle backstop, **not** the refresh rate |
| `DASHBOARD_MAX_REFRESHES_PER_WINDOW=60` | Global ceiling on snapshot rebuilds across all callers |

One dashboard refresh costs a **measured 26** Redis commands across the two
registered queues. This figure scales with the number of registered queues —
re-measure rather than trusting it if that count changes.

### Measuring Redis cost

`CONFIG RESETSTAT`, run the window, then read `INFO commandstats` and sum the
per-command `calls`. Subtract the harness's own `CONFIG`/`INFO` calls and the Docker
healthcheck's pings. Stop the worker to isolate dashboard cost. **Do not run
`npm test` during a measurement window** — it dispatches real jobs against the same
Redis and invalidates the result.

## The dashboard is public and unauthenticated by design

That is a deliberate product decision, not an oversight — it is the artifact being
demonstrated. It means every cost and mutation path must be bounded structurally
rather than by asking visitors to behave. Read `docs/security-remediation.md` before
touching `src/middleware/dashboard.*`; it records every control and why it exists.

### If you change the snapshot cache, test content, not call counts

The cache has produced two separate defects, both of which passed a green suite:

1. Keying on `req.originalUrl` let `?junk=N` bypass the cache entirely — 520 Redis
   commands for 20 requests versus 0 for 20 honest polls.
2. Canonicalizing the *key* without canonicalizing the *request* let `?page=999`
   cache a page-999 body under the page-1 key, poisoning the board for every later
   visitor for a full TTL.

Tests that count upstream calls cannot detect either class of bug. Any change here
must assert that the response body corresponds to the parameters the request
actually asked for. The upstream stand-in in `tests/dashboard.cache.spec.ts` echoes
its received parameters for exactly this reason — keep it that way.

## Documentation is part of the artifact

`docs/security-remediation.md` and `docs/design_decisions.md` are written to be
re-derivable and are read by interviewers. Every figure in them must be measured or
removed. When a previously published number turns out to be wrong, correct it and
say it was wrong — the record of self-correction is the point, and quietly adjusting
arithmetic to fit is the one thing that would make the documents worthless.
