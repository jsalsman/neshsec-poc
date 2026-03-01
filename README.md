# NESHSEC PoC Agent (Cloud Run Ready)

The Native English Speaker Homograph Stress Exemplar Crowdsourcer (NESHSEC) is a TypeScript A2A agent that controls a Prolific study, collects participant recordings for noun/verb homograph paragraphs, forwards submissions to the Syllable Stress Assessment Agent backend as native exemplars, and tracks convergence progress across all 69 target homograph pairs.

## A2A skills

| Skill ID | Purpose | Input params | Output shape |
| --- | --- | --- | --- |
| `study_control` | Launch, monitor, or close the Prolific study lifecycle. | JSON text payload with `skill_id: "study_control"` and `params.action` (`"launch"`, `"status"`, or `"close"`). | JSON summary including study metadata, submission counts, status, and estimated cost. |
| `convergence_status` | Query backend convergence progress (best-effort). | JSON text payload with `skill_id: "convergence_status"` and optional empty `params`. | JSON backend `agent.about` result, used as convergence status until a dedicated endpoint exists. |
| `submit_exemplar` | Forward a native exemplar evaluation request to backend. | JSON text payload with `skill_id: "submit_exemplar"`, `params.paragraph_id` (number), and `params.audio_wav_base64` (string). | Full JSON result returned from backend `pronunciation.evaluate`. |

## Express routes

| Route | Method | Description |
| --- | --- | --- |
| `/record` | `GET` | Minimal participant recording page. Fetches paragraph text from backend and provides record/stop/submit UI. |
| `/submit` | `POST` | Multipart upload endpoint (`audio`, `pid`, `study_id`, `submission_id`, `paragraph_id`) that forwards audio to backend evaluation. |
| `/webhook/prolific` | `POST` | Prolific webhook receiver for `submissions.completed`; increments in-memory counters and logs events. |
| `/healthz` | `GET` | Health endpoint returning `200 {"status":"ok"}`. |

The service also exposes standard A2A SDK routes at `/.well-known/agent.json`, `/a2a`, and `/`.

## Required environment variables

- `PROLIFIC_API_TOKEN`: Prolific API bearer token (sent as `Token <value>`).
- `BACKEND_URL`: Base URL of the Syllable Stress Assessment Agent backend (for example `https://guildaidemo.talknicer.com`).
- `SERVICE_URL`: Public URL for this service (used in agent card URL and Prolific callback/recording links).
- `PORT`: Optional server port (defaults to `8080`).

## Local development quickstart

```bash
export PROLIFIC_API_TOKEN=your_token
export BACKEND_URL=https://guildaidemo.talknicer.com
export SERVICE_URL=http://localhost:8080
npm install && npm run build && node dist/server.js
```

## Cloud Run deploy

```bash
gcloud run deploy neshsec-poc \
  --source . \
  --region us-west1 \
  --allow-unauthenticated \
  --port 8080 \
  --set-env-vars PROLIFIC_API_TOKEN=...,BACKEND_URL=https://guildaidemo.talknicer.com,SERVICE_URL=https://neshsec-poc-974767694043.us-west1.run.app
```

## Production notes

- The PoC keeps `agentState` in memory. For production, persist it in GCS (load on startup, save after mutations) as documented in `src/server.ts` comments.
- Persist recordings and analysis sidecars to GCS (`{recordingId}.wav` and `{recordingId}.json`) to support robust webhook-triggered processing.
- Paragraph assignment is currently fixed (`paragraph_id=1`) for simplicity. A production rollout should use Prolific Taskflow to distribute participants across 10 paragraph variants round-robin.

## References

- A2A JavaScript SDK: https://github.com/a2aproject/a2a-js
