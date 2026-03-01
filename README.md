# Native English Speaker Homograph Stress Exemplar Crowdsourcer (NESHSEC) proof of concept agent

The NESHSEC PoC Agent is a TypeScript A2A service that orchestrates crowdsourced native English speech collection for homograph stress modeling. It exists to bootstrap the [Syllable Stress Assessment Agent](https://guildaidemo.talknicer.com)’s learned threshold calibration by launching a [Prolific.com](https://www.prolific.com) study, collecting native English speaker participants' paragraph recordings, and forwarding those recordings as native exemplars so the backend can improve stress-decision quality across target word pairs.

## How it works

The service exposes A2A skills that let an operator launch, inspect, and close a Prolific study targeted at native English speakers. During launch, the agent creates the study, publishes it, and registers a webhook so completed submissions can be observed by the service. This keeps the study lifecycle operationally centralized in one A2A-callable component.

Participants enter through the Prolific external study URL and land on `GET /record`, where they are assigned a paragraph, shown the text to read, and given simple controls to record, stop, preview playback, and submit. The browser converts captured microphone input into 16kHz mono WAV before upload so submitted audio matches backend requirements.

On `POST /submit`, the service forwards the recording to the Syllable Stress Assessment Agent backend via `pronunciation.evaluate` with `native_exemplar: true`. As exemplars accumulate, the backend’s adaptive pipeline improves threshold calibration, and the PoC agent can query best-effort progress using `convergence_status` while tracking study activity and submission counters toward the full set of 69 target homograph pairs.

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

This route assigns a paragraph (round-robin fallback), fetches paragraph text from the backend, and returns a minimal HTML page with start, stop, playback, and submit controls. Prolific query parameters `pid`, `study_id`, and `submission_id` are captured from the URL, while paragraph assignment is handled server-side when a custom field is unavailable. In production, paragraph distribution should move to Prolific Taskflow variants rather than relying on server-side rotation.

### POST /submit

This route accepts `multipart/form-data` with fields `audio` (file), `pid`, `study_id`, `submission_id`, and `paragraph_id`. It forwards the audio to backend `pronunciation.evaluate` as a native exemplar and returns:

```json
{ "success": true, "completion_code": "STRESS_DONE", "result": { "...": "backend response" } }
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

GCS persistence is now live in the PoC when `GOOGLE_CREDENTIALS` or `GOOGLE_APPLICATION_CREDENTIALS` is configured. `agentState` (including `studyId`, `studyStatus`, submission counters, and `lastAssignedParagraphId`) is loaded from `agent-state.json` in the configured GCS bucket on startup and saved after every mutation. On Cloud Run, set `GOOGLE_CREDENTIALS` to the service account JSON string, or configure a service account with Storage Object Admin on the bucket and rely on Application Default Credentials. Recording and analysis sidecar persistence to GCS is stubbed as a TODO in the `/submit` route for the production upgrade.

Accurate backend alignment depends on audio format: convert browser-captured webm/opus into 16kHz mono WAV before evaluation. In production this can be done using ffmpeg server-side or a robust WebAssembly converter client-side; this step is essential for PocketSphinx alignment quality.

Use Prolific Taskflow API as the primary distribution strategy for paragraph balancing. Instead of a shared round-robin counter, create 10 paragraph-specific study variants with 30 slots each (10 × 30) to avoid concurrency edge cases and ensure deterministic sampling.

## References

- Syllable Stress Assessment Agent backend: https://guildaidemo.talknicer.com
- A2A JavaScript SDK: https://github.com/a2aproject/a2a-js
- Prolific API docs: https://docs.prolific.com/api-reference/introduction
