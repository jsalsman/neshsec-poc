# A2A TypeScript Hello World (Cloud Run Ready)

This repository is a minimal, self-contained TypeScript A2A hello world agent, forked and pared down from the full `a2a-js` SDK repository: https://github.com/a2aproject/a2a-js.

## Endpoints

- `/.well-known/agent.json`: A2A agent card discovery endpoint.
- `/a2a` (and default JSON-RPC route handling from the SDK): JSON-RPC endpoint for task execution.
- `/healthz`: Cloud Run health endpoint (`200 {"status":"ok"}`).

> `/.well-known/agent.json` is the correct agent card path. If you see `agent-card.json` in docs, treat that as a typo.

## Local quickstart

```bash
npm install
npm run build
node dist/server.js
```

The server listens on `PORT` (default `8080`).

## Deploy to Google Cloud Run

```bash
gcloud run deploy a2a-hello-world \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080
```

For the full SDK, examples, and advanced features, see: https://github.com/a2aproject/a2a-js.
