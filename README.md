# Native English Speaker Homograph Stress Exemplar Crowdsourcer (NESHSEC) proof of concept agent

[![Try on Cloud Run](https://img.shields.io/badge/Try_on_Cloud_Run-darkgreen)](https://neshsec-poc.talknicer.com/status)
[![Agent health](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fneshsec-poc.talknicer.com%2Fapi%2Fhealthz&query=%24.status&label=Agent%20health&color=brightgreen&labelColor=indigo)](https://neshsec-poc.talknicer.com/api/healthz)
[![TypeScript version](https://img.shields.io/badge/TypeScript-5.9.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![A2A Compatible](https://img.shields.io/badge/A2A-compatible-purple)](https://a2aprotocol.ai/)
[![Apache 2.0 License](https://img.shields.io/badge/License-Apache%202.0-brightgreen)](https://opensource.org/licenses/apache-2-0)
[![Donate](https://img.shields.io/badge/Donate-gold?logo=paypal)](https://paypal.me/jsalsman)

The NESHSEC PoC Agent is a TypeScript A2A service that orchestrates crowdsourced native English speech collection for homograph stress modeling. It exists to bootstrap the [Syllable Stress Assessment Agent](https://guildaidemo.talknicer.com)’s learned threshold calibration by launching a [Prolific.com](https://www.prolific.com) study, collecting native English speaker participants' paragraph recordings, and forwarding those recordings as native exemplars so the backend can improve stress-decision quality across target word pairs.

## How it works

The service exposes A2A skills that let an operator launch, inspect, and close a Prolific study targeted at native English speakers. During launch, the agent creates the study, publishes it, and registers a webhook so completed submissions can be observed by the service. This keeps the study lifecycle operationally centralized in one A2A-callable component.

Participants enter through the Prolific external study URL and land on `GET /record`, where they are assigned two paragraphs, shown both texts to read, and given sequential controls to record, stop, preview playback, and submit both recordings. The browser converts captured microphone input into 16kHz mono WAV before upload so submitted audio matches backend requirements.

On `POST /submit`, the service forwards both recordings to the Syllable Stress Assessment Agent backend via `pronunciation.evaluate` with `native_exemplar: true`. As exemplars accumulate, the backend’s adaptive pipeline improves threshold calibration, and the PoC agent can query best-effort progress using `convergence_status` while tracking study activity and submission counters toward the full set of 69 target homograph pairs.

## A2A skills

### study_control

This skill manages Prolific study lifecycle actions (launch, status, close).

Input:

```json
{ "skill_id": "study_control", "params": { "action": "launch" | "status" | "close" } }
```

Output:
- `launch`: `{ success, studyId, studyStatus, estimatedCostUsd, estimatedCostNote }`
- `status`: `{ success, study, submissions: { count }, agentState }`
- `close`: `{ success, studyId, studyStatus, closeResponse }`

`launch` creates the study, publishes it, and registers the webhook in one call. Estimated total includes an approximate 33% Prolific platform fee on top of the $1.50 participant reward.

Example invocation:

```json
{
  "skill_id": "study_control",
  "params": {
    "action": "launch"
  }
}
```

### convergence_status

This skill requests best-effort backend convergence telemetry.

Input:

```json
{ "skill_id": "convergence_status", "params": {} }
```

Output: the raw `agent.about` result returned by the Syllable Stress Assessment Agent backend.

A dedicated convergence endpoint does not yet exist on the backend, so this is currently a best-effort status check. A future backend A2A method (`convergence_status`) is expected to expose per-word `decision_method` counts directly.

Example invocation:

```json
{
  "skill_id": "convergence_status",
  "params": {}
}
```

### submit_exemplar

This skill forwards one native exemplar recording for backend evaluation and calibration.

Input:

```json
{ "skill_id": "submit_exemplar", "params": { "paragraph_id": 3, "audio_wav_base64": "<base64-encoded 16kHz mono WAV>" } }
```

Output: the full `pronunciation.evaluate` result from the backend, including per-target stress evaluations and `score_summary`.

Audio must be 16kHz mono WAV. The service recording page now converts browser-captured audio to that format before submission.

Example invocation:

```json
{
  "skill_id": "submit_exemplar",
  "params": {
    "paragraph_id": 3,
    "audio_wav_base64": "UklGRiQAAABXQVZFZm10IBAAAAABAAEA..."
  }
}
```

## Express routes

### GET /status

Browser-friendly status dashboard showing study state and backend convergence data side by side. Auto-refreshes every 10 seconds. Links to /launch, /close, and /record.

### GET /launch

Browser-accessible confirmation page that POSTs to /api/study/launch on button click and displays the JSON result inline. Includes a link to /status.

### GET /close

Browser-accessible confirmation page that POSTs to /api/study/close on button click and displays the JSON result inline. Includes a link to /status.

### GET /api/study/status

Returns current `agentState` and live Prolific study data (submission count and study object) if a study is active. Returns `prolific: null` if no study has been launched. Useful for monitoring without an A2A client.

### POST /api/study/launch

Creates, publishes, and registers webhook for a new Prolific study in one call. Returns `409` if a study is already active. Equivalent to the `study_control` launch A2A skill but callable with plain curl or a browser.

Example:

```bash
curl -X POST https://neshsec-poc.talknicer.com/api/study/launch
```

### POST /api/study/close

Stops the active Prolific study. Returns `404` if no study is active.

Example:

```bash
curl -X POST https://neshsec-poc.talknicer.com/api/study/close
```

### GET /api/convergence

Calls the backend `agent.about` endpoint and returns convergence status.

Example:

```bash
curl https://neshsec-poc.talknicer.com/api/convergence
```

### GET /record

This route assigns two paragraphs (round-robin fallback), fetches both paragraph texts from the backend, and returns a minimal HTML page with two recording controls (one per paragraph), playback for each recording, and a shared submit button that enables only after both recordings are ready. Prolific query parameters `pid`, `study_id`, and `submission_id` are captured from the URL, while paragraph assignment is handled server-side when a custom field is unavailable. In production, paragraph distribution should move to Prolific Taskflow variants rather than relying on server-side rotation.

### POST /submit

This route accepts `multipart/form-data` with fields `audio_1` (file), `audio_2` (file), `pid`, `study_id`, `submission_id`, `paragraph_id_1`, and `paragraph_id_2`. It forwards both recordings to backend `pronunciation.evaluate` as native exemplars and returns:

```json
{ "success": true, "completion_code": "STRESS_DONE", "result1": { "...": "backend response" }, "result2": { "...": "backend response" } }
```

The backend requires 16kHz mono WAV, and the recording page performs conversion before upload.

### POST /webhook/prolific

This route receives Prolific `submissions.completed` events and increments the in-memory `submissionsReceived` counter. A production enhancement would retrieve persisted audio from GCS and forward automatically when webhook events arrive.

### GET /api/healthz

Returns `200` with JSON:

```json
{ "status": "ok" }
```

### A2A routes

The A2A SDK middleware handles `/.well-known/agent.json`, `/a2a`, and `/`. The correct agent card route is `/.well-known/agent.json` (some documentation references `agent-card.json`, which is a typo).

## Environment variables

| Variable | Default | Description |
|---|---|---|
| PROLIFIC_API_TOKEN | PLACEHOLDER | Prolific Bearer token. Get from prolific.com. |
| BACKEND_URL | https://guildaidemo.talknicer.com | Base URL of Syllable Stress Assessment Agent. |
| SERVICE_URL | https://neshsec-poc.talknicer.com | Public URL of this service, used in agent card and Prolific study URL. |
| GCS_BUCKET_NAME | neshsec-poc | GCS bucket name for persistent state and recording sidecars. |
| GOOGLE_CREDENTIALS | (none) | Service account JSON string for GCS access. If unset, falls back to Application Default Credentials (works automatically on Cloud Run with a configured service account). |
| PORT | 8080 | HTTP listen port. |

## Local development quickstart

```bash
export PROLIFIC_API_TOKEN=your_token
export BACKEND_URL=https://guildaidemo.talknicer.com
export SERVICE_URL=http://localhost:8080
npm install && npm run build && npm run start
```

If `npm run build` reports missing modules or type declarations (for example `@google-cloud/storage` or `undici`), install dependencies from the lockfile first:

```bash
npm ci
```

Without a valid `PROLIFIC_API_TOKEN`, `study_control` calls return a clear `PROLIFIC_API_TOKEN_MISSING_OR_INVALID` error. The `/record` and `/submit` routes and `convergence_status` skill still operate independently of Prolific credentials.

## Cloud Run deploy

```bash
gcloud run deploy neshsec-poc \
  --source . \
  --region us-west1 \
  --allow-unauthenticated \
  --port 8080 \
  --set-env-vars PROLIFIC_API_TOKEN=...,\
BACKEND_URL=https://guildaidemo.talknicer.com,\
SERVICE_URL=https://neshsec-poc.talknicer.com,\
GCS_BUCKET_NAME=neshsec-poc,\
GOOGLE_CREDENTIALS='{"type":"service_account","project_id":"..."}'
```

## Production notes

GCS persistence is now live in the PoC when `GOOGLE_CREDENTIALS` is configured. `agentState` (including `studyId`, `studyStatus`, submission counters, and `lastAssignedParagraphId`) is loaded from `agent-state.json` in the configured GCS bucket on startup and saved after every mutation. On Cloud Run, set `GOOGLE_CREDENTIALS` to the service account JSON string for the service account that has Storage Object Admin on the bucket. Recording and analysis sidecar persistence to GCS is stubbed as a TODO in the `/submit` route for the production upgrade.

Accurate backend alignment depends on audio format: convert browser-captured webm/opus into 16kHz mono WAV before evaluation. In production this can be done using ffmpeg server-side or a robust WebAssembly converter client-side; this step is essential for PocketSphinx alignment quality.

Use Prolific Taskflow API as the primary distribution strategy for paragraph balancing. Instead of a shared round-robin counter, create 10 paragraph-specific study variants with 15 slots each (10 × 15) to avoid concurrency edge cases and ensure deterministic sampling.

The current PoC cost estimate is approximately $299 USD including Prolific platform fees (~33%) for 150 participants at $1.50 each (excludes VAT).

## References

- Syllable Stress Assessment Agent backend: https://guildaidemo.talknicer.com
- A2A JavaScript SDK: https://github.com/a2aproject/a2a-js
- Prolific API docs: https://docs.prolific.com/api-reference/introduction

## Draft Guild.ai agent project proposal

**The Oath:**
The Native English Speaker Homograph Stress Exemplar Crowdsourcer (NESHSEC) is an agent that recruits native English speakers via Prolific to record themselves reading paragraphs containing noun/verb homograph pairs, then submits those recordings to the Syllable Stress Assessment Agent as native exemplars. Its purpose is to bootstrap the data-driven stress-inference calibration of that backend, bringing threshold accuracy from a naive duration heuristic to approximately 95% correct — the practical ceiling given natural within-speaker variability. Without sufficient native exemplar data the Syllable Stress Assessment Agent falls back to a simple "longer syllable wins" heuristic; this agent exists to replace that fallback with statistically grounded, learned thresholds for all 69 target homograph pairs.

**The Reagents:**
The agent is implemented in TypeScript and deployed on the Guild platform. It depends on the Prolific API to create and monitor a study, recruit participants, and retrieve completed submission metadata. Each participant is presented with two of ten paragraphs covering all 69 target noun/verb homograph pairs as both parts of speech, and records themselves reading each aloud via a browser-based interface with per-paragraph toggle record, playback, and submit controls. Completed audio submissions are forwarded in parallel to the existing Syllable Stress Assessment Agent — a live A2A-compatible Python backend at guildaidemo.talknicer.com — via its `pronunciation.evaluate` JSON-RPC endpoint with `native_exemplar: true`, which persists each WAV and analysis sidecar to Google Cloud Storage and folds the new data into the backend's adaptive threshold computation. Agent state (study ID, submission counters, paragraph assignment cursor) is persisted to a separate GCS bucket via the `GOOGLE_CREDENTIALS` service account, surviving restarts. Prolific participant fees for approximately 150 submissions of two recordings each (300 total exemplars) are estimated at ~£300 including platform fees at £1.50 per submission — Prolific's enforced minimum reward.

**The Ritual:**
The agent exposes three A2A skills (`study_control`, `convergence_status`, `submit_exemplar`) and companion human-navigable browser routes (`/launch`, `/close`, `/status`, `/record`). Launching via `/launch` or the `study_control` skill creates, publishes, and registers a Prolific webhook in a single call. Participants land on `/record`, are assigned two paragraphs via a server-side round-robin counter, record both, preview playback, and submit; the `/submit` route forwards both WAVs in parallel to the backend as native exemplars. Prolific completion webhook events increment the submission counter in persisted agent state. The `/status` dashboard displays live study state, submission counters, and backend capability metadata, auto-refreshing every ten seconds. The `convergence_status` skill and `/api/convergence` route query the backend's `agent.about` endpoint as a best-effort convergence check until a dedicated `convergence_status` backend method is added.

**The Proof:**
The agent has succeeded when all 69 target homograph pairs report `decision_method: learned_threshold` in the Syllable Stress Assessment Agent's evaluation responses, indicating that naive duration fallback has been fully replaced by native-exemplar-derived inference. The headline before/after metric is `percent_correct` on a held-out validation set of test fixture WAVs replayed against the backend before the Prolific study begins and again after convergence, quantifying the accuracy improvement the crowdsourced exemplar data delivered. Study completion and per-word convergence progress are themselves exposed as observable agent state via the `/status` dashboard and `convergence_status` skill, making the crowdsourcing pipeline inspectable and steerable throughout its run.
