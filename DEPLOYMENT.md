# Deployment

The full runbook lives in **[docs/deployment.md](docs/deployment.md)** — this
file is the pointer, so the deployment entry point is where a reader expects it
in every one of these repos.

## At a glance

| | |
|---|---|
| Host | Render (web service, Oregon, `starter`) — `srv-d9r78q0n74is73e77sag` |
| URL | https://slake-task-queue.onrender.com |
| Auto-deploy | on, per commit to `main` |
| Build | `npm ci --include=dev && npm run build && npm prune --omit=dev` |
| Start | `npm start` |
| Consumed by | `slakedesign.com/demo/queue` via `netlify/functions/queue-demo.js` |
| Redis | Upstash — see the command-budget notes in `docs/design_decisions.md` before changing worker tuning |

Environment variables, rollback steps, behavioural changes and the post-deploy
smoke test are all in [docs/deployment.md](docs/deployment.md).
