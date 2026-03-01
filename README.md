# NESHSEC PoC Agent (Cloud Run Ready)

The Native English Speaker Homograph Stress Exemplar Crowdsourcer (NESHSEC) is a TypeScript A2A agent that controls a Prolific study, collects participant recordings for noun/verb homograph paragraphs, forwards submissions to the Syllable Stress Assessment Agent backend as native exemplars, and tracks convergence progress across all 69 target homograph pairs.

## A2A skills

| Skill ID | Purpose | Input params | Output shape |
| --- | --- | --- | --- |
| `study_control` | Launch, monitor, or close the Prolific study lifecycle. | JSON text payload with `skill_id: "study_control"` and `params.action` (`"launch"`, `"status"`, or `"close"`). | JSON summary including study metadata, submission counts, status, and estimated cost. If Prolific rejects due to auth, the task returns a failed A2A status with an error stating that `PROLIFIC_API_TOKEN` must be set correctly. |
| `convergence_status` | Query backend convergence progress (best-effort). | JSON text payload with `skill_id: "convergence_status"` and optional empty `params`. | JSON backend `agent.about` result, used as convergence status until a dedicated endpoint exists. |
| `submit_exemplar` | Forward a native exemplar evaluation request to backend. | JSON text payload with `skill_id: "submit_exemplar"`, `params.paragraph_id` (number), and `params.audio_wav_base64` (string). | Full JSON result returned from backend `pronunciation.evaluate`. |

## Express routes

| Route | Method | Description |
| --- | --- | --- |
| `/record` | `GET` | Participant recording page. Assigns paragraph IDs in round-robin order by reading paragraph count from backend (`paragraphs.count`) and fetching paragraph text via `paragraphs.get_text`; displays prompt text before recording buttons. |
| `/submit` | `POST` | Multipart upload endpoint (`audio`, `pid`, `study_id`, `submission_id`, `paragraph_id`) that forwards audio to backend evaluation. |
| `/webhook/prolific` | `POST` | Prolific webhook receiver for `submissions.completed`; increments in-memory counters and logs events. |
| `/healthz` | `GET` | Health endpoint returning `200 {"status":"ok"}`. |

The service also exposes standard A2A SDK routes at `/.well-known/agent.json`, `/a2a`, and `/`.

## Environment variables

Defaults are applied when values are missing:

- `PROLIFIC_API_TOKEN=PLACEHOLDER`
- `BACKEND_URL=https://guildaidemo.talknicer.com`
- `SERVICE_URL=https://neshsec-poc.talknicer.com`
- `PORT=8080` (if not set)

If `PROLIFIC_API_TOKEN` is missing/invalid and Prolific rejects requests, the agent returns a clear error telling operators to configure `PROLIFIC_API_TOKEN`.

If `HTTP_PROXY`/`HTTPS_PROXY` (or lowercase variants) are set, outbound backend and Prolific fetches use those proxy settings automatically (helps avoid `ENETUNREACH` in proxied environments).

## Local development quickstart

```bash
export PROLIFIC_API_TOKEN=your_token
export BACKEND_URL=https://guildaidemo.talknicer.com
export SERVICE_URL=http://localhost:8080
npm install && npm run build && npm run start
```

## Cloud Run deploy

```bash
gcloud run deploy neshsec-poc \
  --source . \
  --region us-west1 \
  --allow-unauthenticated \
  --port 8080 \
  --set-env-vars PROLIFIC_API_TOKEN=...,BACKEND_URL=https://guildaidemo.talknicer.com,SERVICE_URL=https://neshsec-poc.talknicer.com
```

## Production notes

- The PoC keeps `agentState` in memory. For production, persist it in GCS (load on startup, save after mutations) as documented in `src/server.ts` comments.
- Persist the round-robin pointer (`lastAssignedParagraphId`) in that same GCS state object so distribution survives restarts.
- Persist recordings and analysis sidecars to GCS (`{recordingId}.wav` and `{recordingId}.json`) to support robust webhook-triggered processing.

## References

- A2A JavaScript SDK: https://github.com/a2aproject/a2a-js
