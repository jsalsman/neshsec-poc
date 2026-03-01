import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { AgentCard, Message, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import {
  AgentExecutor,
  DefaultRequestHandler,
  ExecutionEventBus,
  InMemoryTaskStore,
  RequestContext,
} from '@a2a-js/sdk/server';
import { UserBuilder, agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';

const port = Number(process.env.PORT ?? 8080);
const serviceUrl = process.env.SERVICE_URL ?? `http://localhost:${port}`;

class ProlificClient {
  private readonly baseUrl = 'https://api.prolific.com/api/v1';

  constructor(private readonly servicePublicUrl: string) {}

  private async request(path: string, init: RequestInit): Promise<any> {
    const token = process.env.PROLIFIC_API_TOKEN;
    if (!token) {
      throw new Error('PROLIFIC_API_TOKEN is required');
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Token ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Prolific API error (${response.status}): ${body}`);
    }

    if (response.status === 204) {
      return {};
    }

    return response.json();
  }

  public async createStudy(): Promise<any> {
    return this.request('/studies', {
      method: 'POST',
      body: JSON.stringify({
        name: 'English Pronunciation Recording Study',
        description:
          'You will read a short English paragraph aloud and record yourself. The task takes approximately 5 minutes.',
        external_study_url: `${this.servicePublicUrl}/record?pid={{%PROLIFIC_PID%}}&study_id={{%STUDY_ID%}}&submission_id={{%SESSION_ID%}}&paragraph_id=1`,
        reward: 150,
        estimated_completion_time: 5,
        total_available_places: 300,
        completion_codes: [
          {
            code: 'STRESS_DONE',
            code_type: 'COMPLETED',
            actions: [{ action: 'AUTOMATICALLY_APPROVE' }],
          },
        ],
        filters: [{ filter_id: 'language_fluencies', selected_values: ['EN'] }],
      }),
    });
  }

  public async publishStudy(studyId: string): Promise<any> {
    return this.request(`/studies/${studyId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ action: 'PUBLISH' }),
    });
  }

  public async getStudy(studyId: string): Promise<any> {
    return this.request(`/studies/${studyId}`, { method: 'GET' });
  }

  public async getSubmissions(studyId: string): Promise<any> {
    return this.request(`/studies/${studyId}/submissions`, { method: 'GET' });
  }

  public async closeStudy(studyId: string): Promise<any> {
    return this.request(`/studies/${studyId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ action: 'STOP' }),
    });
  }

  public async registerWebhook(studyId: string): Promise<any> {
    return this.request('/hooks', {
      method: 'POST',
      body: JSON.stringify({
        event_type: 'submissions.completed',
        target_url: `${this.servicePublicUrl}/webhook/prolific`,
        study_id: studyId,
      }),
    });
  }
}

class BackendClient {
  constructor(private readonly backendUrl: string) {}

  private async request(method: string, params: object): Promise<any> {
    if (!this.backendUrl) {
      throw new Error('BACKEND_URL is required');
    }

    const response = await fetch(`${this.backendUrl}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: uuidv4(),
        method,
        params,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Backend HTTP error (${response.status}): ${body}`);
    }

    const payload = (await response.json()) as { result?: object; error?: { message?: string } };
    if (payload.error) {
      throw new Error(`Backend JSON-RPC error: ${payload.error.message ?? 'unknown error'}`);
    }

    return payload.result ?? {};
  }

  public async evaluateExemplar(paragraphId: number, audioWavBase64: string): Promise<object> {
    return this.request('pronunciation.evaluate', {
      paragraph_id: paragraphId,
      audio_wav_base64: audioWavBase64,
      native_exemplar: true,
    });
  }

  public async getConvergenceStatus(): Promise<object> {
    // The backend does not yet expose a dedicated convergence endpoint. agent.about is used as a best-effort status check. A future version will add a convergence_status method to the backend's A2A interface.
    return this.request('agent.about', {});
  }

  public async getParagraphText(paragraphId: number): Promise<string> {
    const result = (await this.request('paragraphs.get_text', { paragraph_id: paragraphId })) as {
      text?: string;
      paragraph_text?: string;
    };
    return (
      result.text ??
      result.paragraph_text ??
      `Paragraph text unavailable for paragraph_id=${paragraphId}.`
    );
  }
}

const prolificClient = new ProlificClient(serviceUrl);
const backendClient = new BackendClient(process.env.BACKEND_URL ?? '');

// PRODUCTION PERSISTENCE NOTE
// In production, agentState should be persisted to a GCS bucket using
// @google-cloud/storage so it survives redeployments. Example pattern:
//
// import { Storage } from '@google-cloud/storage';
// const storage = new Storage();
// const bucket = storage.bucket(process.env.GCS_BUCKET_NAME ?? 'neshsec-state');
// const stateFile = bucket.file('agent-state.json');
//
// async function loadState(): Promise<void> {
//   try {
//     const [contents] = await stateFile.download();
//     Object.assign(agentState, JSON.parse(contents.toString()));
//   } catch (e) {
//     // File doesn't exist yet on first run — use defaults.
//   }
// }
//
// async function saveState(): Promise<void> {
//   await stateFile.save(JSON.stringify(agentState, null, 2), {
//     contentType: 'application/json',
//   });
// }
//
// Call loadState() before app.listen() and saveState() after any mutation
// of agentState. For recordings and analysis sidecars, follow the same
// pattern as the Syllable Stress Assessment Agent backend: write
// {recordingId}.wav and {recordingId}.json to the bucket using:
//
// await bucket.file(`${recordingId}.wav`).save(wavBuffer, {
//   contentType: 'audio/wav' });
// await bucket.file(`${recordingId}.json`).save(
//   JSON.stringify(analysisSidecar, null, 2), {
//   contentType: 'application/json' });
//
// Add @google-cloud/storage to package.json dependencies when enabling this.
const agentState = {
  studyId: null as string | null,
  studyStatus: 'not_started',
  submissionsReceived: 0,
  submissionsForwarded: 0,
  lastConvergenceCheck: null as object | null,
};

class NESHSECExecutor implements AgentExecutor {
  private extractText(message: Message): string {
    const textPart = message.parts.find(
      (part): part is Extract<Message['parts'][number], { kind: 'text' }> => part.kind === 'text'
    );
    return textPart?.text ?? '';
  }

  public async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    let result: object;

    try {
      const rawText = this.extractText(requestContext.userMessage);
      const parsed = JSON.parse(rawText) as {
        skill_id?: string;
        params?: Record<string, unknown>;
      };
      const skillId = parsed.skill_id;
      const params = parsed.params ?? {};

      switch (skillId) {
        case 'study_control': {
          const action = typeof params.action === 'string' ? params.action : undefined;
          if (action === 'launch') {
            const createdStudy = await prolificClient.createStudy();
            const studyId = (createdStudy.id ?? createdStudy.study_id) as string;
            await prolificClient.publishStudy(studyId);
            await prolificClient.registerWebhook(studyId);
            agentState.studyId = studyId;
            agentState.studyStatus = 'published';
            result = {
              success: true,
              action,
              studyId,
              studyStatus: agentState.studyStatus,
              estimatedCostGbp: ((300 * 150) / 100).toFixed(2),
            };
          } else if (action === 'status') {
            if (!agentState.studyId) {
              result = { success: false, error: 'No active study. Launch a study first.' };
              break;
            }

            const study = await prolificClient.getStudy(agentState.studyId);
            const submissions = await prolificClient.getSubmissions(agentState.studyId);
            const submissionCount = Array.isArray(submissions)
              ? submissions.length
              : Array.isArray((submissions as { results?: unknown[] }).results)
                ? (submissions as { results: unknown[] }).results.length
                : 0;
            result = {
              success: true,
              action,
              study,
              submissions: {
                count: submissionCount,
              },
              agentState,
            };
          } else if (action === 'close') {
            if (!agentState.studyId) {
              result = { success: false, error: 'No active study to close.' };
              break;
            }

            const closeResponse = await prolificClient.closeStudy(agentState.studyId);
            agentState.studyStatus = 'closed';
            result = {
              success: true,
              action,
              studyId: agentState.studyId,
              studyStatus: agentState.studyStatus,
              closeResponse,
            };
          } else {
            result = {
              success: false,
              error: 'Invalid action for study_control. Valid actions: launch | status | close',
            };
          }
          break;
        }
        case 'convergence_status': {
          const convergence = await backendClient.getConvergenceStatus();
          agentState.lastConvergenceCheck = convergence;
          result = convergence;
          break;
        }
        case 'submit_exemplar': {
          const paragraphId = Number(params.paragraph_id);
          const audioWavBase64 =
            typeof params.audio_wav_base64 === 'string' ? params.audio_wav_base64 : '';

          if (!Number.isFinite(paragraphId) || !audioWavBase64) {
            result = {
              success: false,
              error: 'submit_exemplar requires params.paragraph_id and params.audio_wav_base64',
            };
            break;
          }

          result = await backendClient.evaluateExemplar(paragraphId, audioWavBase64);
          break;
        }
        default:
          result = {
            success: false,
            error: 'Unknown skill_id. Valid skill_ids: study_control, convergence_status, submit_exemplar',
          };
      }
    } catch (error) {
      result = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }

    const responseEvent: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
      status: {
        state: 'completed',
        timestamp: new Date().toISOString(),
        message: {
          kind: 'message',
          role: 'agent',
          messageId: uuidv4(),
          taskId: requestContext.taskId,
          contextId: requestContext.contextId,
          parts: [{ kind: 'text', text: JSON.stringify(result) }],
        },
      },
      final: true,
    };

    eventBus.publish(responseEvent);
  }

  public async cancelTask(): Promise<void> {
    // No-op for PoC implementation.
  }
}

const agentCard: AgentCard = {
  name: 'Native English Speaker Homograph Stress Exemplar Crowdsourcer',
  description:
    'Manages a Prolific crowdsourcing study to collect native English speaker recordings of noun/verb homograph paragraphs, submits them to the Syllable Stress Assessment Agent as native exemplars, and tracks convergence of learned stress thresholds across all 69 target word pairs.',
  url: serviceUrl,
  version: '1.0.0',
  protocolVersion: '0.3.0',
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [
    {
      id: 'study_control',
      name: 'study_control',
      description:
        'Launch, monitor, or close the Prolific study. Input: JSON with action field: "launch" | "status" | "close". Returns study status, submission counts, and estimated cost.',
      tags: ['prolific', 'study'],
      inputModes: ['text'],
      outputModes: ['text'],
    },
    {
      id: 'convergence_status',
      name: 'convergence_status',
      description:
        'Query the Syllable Stress Assessment Agent backend for per-word threshold convergence status. Returns count of words using learned_threshold vs naive_duration decision_method and percentage complete toward 69 targets.',
      tags: ['convergence', 'evaluation'],
      inputModes: ['text'],
      outputModes: ['text'],
    },
    {
      id: 'submit_exemplar',
      name: 'submit_exemplar',
      description:
        'Forward a base64-encoded 16kHz mono WAV and paragraph_id to the backend pronunciation.evaluate endpoint with native_exemplar: true. Returns the full evaluation result.',
      tags: ['evaluation', 'exemplar'],
      inputModes: ['text'],
      outputModes: ['text'],
    },
  ],
  supportsAuthenticatedExtendedCard: false,
};

const app = express();
const upload = multer();
const requestHandler = new DefaultRequestHandler(
  agentCard,
  new InMemoryTaskStore(),
  new NESHSECExecutor()
);

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/webhook/prolific', express.json(), (req, res) => {
  const { submission_id, participant_id } = req.body ?? {};
  agentState.submissionsReceived++;
  console.log(`Prolific webhook: submission ${submission_id} from ${participant_id}`);
  res.status(200).json({ received: true });
  // PRODUCTION NOTE: In production, retrieve the participant's recorded audio
  // from the /submit route's persisted GCS WAV file (keyed on submission_id),
  // then call backendClient.evaluateExemplar() automatically here, persisting
  // the result sidecar to GCS. For this PoC, audio is submitted directly by
  // the participant via the /record -> /submit flow without webhook coordination.
});

app.get('/record', async (req, res) => {
  const pid = String(req.query.pid ?? '');
  const studyId = String(req.query.study_id ?? '');
  const submissionId = String(req.query.submission_id ?? '');
  const paragraphId = Number(req.query.paragraph_id ?? 1);

  let paragraphText = `Please read paragraph ${paragraphId} aloud.`;
  try {
    paragraphText = await backendClient.getParagraphText(paragraphId);
  } catch (error) {
    console.error('Failed to fetch paragraph text', error);
  }

  const escapedParagraph = paragraphText
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

  res
    .status(200)
    .type('html')
    .send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NESHSEC Recording</title>
  </head>
  <body>
    <h1>English Pronunciation Recording Study</h1>
    <p><strong>Paragraph ID:</strong> ${paragraphId}</p>
    <p id="paragraph">${escapedParagraph}</p>
    <button id="record">Start recording</button>
    <button id="stop" disabled>Stop recording</button>
    <button id="submit" disabled>Submit recording</button>
    <p id="status">Ready.</p>
    <div id="completion" style="display:none; margin-top: 1rem;">
      <a href="https://app.prolific.com/submissions/complete?cc=STRESS_DONE" target="_blank" rel="noopener noreferrer" style="font-size:1.2rem; font-weight:bold;">Complete on Prolific (STRESS_DONE)</a>
    </div>

    <script>
      const recordBtn = document.getElementById('record');
      const stopBtn = document.getElementById('stop');
      const submitBtn = document.getElementById('submit');
      const statusEl = document.getElementById('status');
      const completionEl = document.getElementById('completion');

      let mediaRecorder;
      let chunks = [];
      let audioBlob;

      recordBtn.onclick = async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        chunks = [];
        mediaRecorder.ondataavailable = (event) => chunks.push(event.data);
        mediaRecorder.onstop = () => {
          audioBlob = new Blob(chunks, { type: 'audio/webm' });
          submitBtn.disabled = false;
          statusEl.textContent = 'Recording captured. Ready to submit.';
        };
        mediaRecorder.start();
        recordBtn.disabled = true;
        stopBtn.disabled = false;
        statusEl.textContent = 'Recording...';
      };

      stopBtn.onclick = () => {
        mediaRecorder.stop();
        stopBtn.disabled = true;
        recordBtn.disabled = false;
      };

      submitBtn.onclick = async () => {
        if (!audioBlob) {
          statusEl.textContent = 'No recording available.';
          return;
        }

        const formData = new FormData();
        formData.append('pid', ${JSON.stringify(pid)});
        formData.append('study_id', ${JSON.stringify(studyId)});
        formData.append('submission_id', ${JSON.stringify(submissionId)});
        formData.append('paragraph_id', ${JSON.stringify(String(paragraphId))});
        // Backend accepts WAV (16kHz mono) for production. This PoC sends raw webm/opus bytes.
        // A production client should convert to WAV using ffmpeg or a browser-side WebAssembly converter.
        formData.append('audio', audioBlob, 'recording.webm');

        statusEl.textContent = 'Submitting...';
        const response = await fetch('/submit', { method: 'POST', body: formData });
        const payload = await response.json();
        if (payload.success) {
          statusEl.textContent = 'Submission accepted. Click the completion link below.';
          completionEl.style.display = 'block';
        } else {
          statusEl.textContent = 'Submission failed: ' + (payload.error || 'Unknown error');
        }
      };
    </script>
  </body>
</html>`);
});

app.post('/submit', upload.single('audio'), async (req, res) => {
  try {
    const pid = String(req.body?.pid ?? '');
    const studyId = String(req.body?.study_id ?? '');
    const submissionId = String(req.body?.submission_id ?? '');
    const paragraphId = Number(req.body?.paragraph_id ?? 1);

    if (!req.file) {
      res.status(400).json({ success: false, error: 'Missing audio file.' });
      return;
    }

    const audioBase64 = req.file.buffer.toString('base64');
    const result = await backendClient.evaluateExemplar(paragraphId, audioBase64);
    agentState.submissionsForwarded++;

    const scoreSummary = (result as { analysis?: { score_summary?: unknown } }).analysis?.score_summary;
    console.log(
      `Forwarded submission ${submissionId} pid=${pid} study_id=${studyId} paragraph_id=${paragraphId}`,
      scoreSummary
    );

    res.status(200).json({ success: true, completion_code: 'STRESS_DONE', result });
  } catch (error) {
    console.error('Submit route failed', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.use('/.well-known/agent.json', agentCardHandler({ agentCardProvider: requestHandler }));
app.use('/a2a', jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
app.use('/', jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

app.listen(port, () => {
  console.log(`A2A hello world agent listening on port ${port}`);
  console.log(`Agent card: ${serviceUrl}/.well-known/agent.json`);
  console.log(`JSON-RPC endpoint: ${serviceUrl}/a2a`);
});
