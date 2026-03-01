import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { Storage } from '@google-cloud/storage';
import { AgentCard, Message, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import {
  AgentExecutor,
  DefaultRequestHandler,
  ExecutionEventBus,
  InMemoryTaskStore,
  RequestContext,
} from '@a2a-js/sdk/server';
import { UserBuilder, agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { Dispatcher, EnvHttpProxyAgent } from 'undici';

const port = Number(process.env.PORT ?? 8080);
const prolificApiToken = process.env.PROLIFIC_API_TOKEN ?? 'PLACEHOLDER';
const backendUrl = process.env.BACKEND_URL ?? 'https://guildaidemo.talknicer.com';
const serviceUrl = process.env.SERVICE_URL ?? 'https://neshsec-poc.talknicer.com';
const googleCredentials = process.env.GOOGLE_CREDENTIALS
  ? JSON.parse(process.env.GOOGLE_CREDENTIALS)
  : undefined;
const gcsBucketName = process.env.GCS_BUCKET_NAME ?? 'neshsec-poc';

const storage = googleCredentials
  ? new Storage({ credentials: googleCredentials, projectId: googleCredentials.project_id })
  : new Storage(); // Falls back to Application Default Credentials on Cloud Run
const gcsBucket = storage.bucket(gcsBucketName);
const stateFile = gcsBucket.file('agent-state.json');

const proxyDispatcher: Dispatcher | undefined =
  process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy
    ? new EnvHttpProxyAgent()
    : undefined;

type FetchInitWithDispatcher = RequestInit & { dispatcher?: Dispatcher };

class ProlificConfigurationError extends Error {
  constructor() {
    super(
      'Prolific request rejected. Please set PROLIFIC_API_TOKEN in environment variables to a valid Prolific API token.'
    );
  }
}

class ProlificClient {
  private readonly baseUrl = 'https://api.prolific.com/api/v1';

  constructor(private readonly servicePublicUrl: string) {}

  private async request(path: string, init: RequestInit): Promise<any> {
    const requestInit: FetchInitWithDispatcher = {
      ...init,
      ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
      headers: {
        Authorization: `Token ${prolificApiToken}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    };

    const response = await fetch(`${this.baseUrl}${path}`, requestInit);

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 401 || response.status === 403) {
        throw new ProlificConfigurationError();
      }
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
        // NOTE: paragraph_id is passed via a Prolific custom study field. In the PoC,
        // if Prolific does not support custom fields on this plan, the /record route
        // falls back to round-robin assignment via lastAssignedParagraphId.
        // A production version would use Prolific's Taskflow API to create 10 study
        // variants (one per paragraph), each with 30 participant slots.
        external_study_url: `${this.servicePublicUrl}/record?pid={{%PROLIFIC_PID%}}&study_id={{%STUDY_ID%}}&submission_id={{%SESSION_ID%}}&paragraph_id={{%CUSTOM_STUDY_FIELD_paragraph_id%}}`,
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

    const requestInit: FetchInitWithDispatcher = {
      method: 'POST',
      ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: uuidv4(),
        method,
        params,
      }),
    };

    const response = await fetch(`${this.backendUrl}/a2a`, requestInit);

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

  public async getParagraphCount(): Promise<number> {
    const result = (await this.request('paragraphs.count', {})) as {
      count?: number;
      paragraph_count?: number;
      total?: number;
    };
    const paragraphCount = Number(result.count ?? result.paragraph_count ?? result.total ?? 1);
    return Number.isFinite(paragraphCount) && paragraphCount > 0 ? paragraphCount : 1;
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
const backendClient = new BackendClient(backendUrl);

async function loadState(): Promise<void> {
  if (!googleCredentials) {
    console.log('GOOGLE_CREDENTIALS not configured — using in-memory state only.');
    return;
  }
  try {
    const [contents] = await stateFile.download();
    const loaded = JSON.parse(contents.toString());
    Object.assign(agentState, loaded);
    console.log('State loaded from GCS:', JSON.stringify(agentState));
  } catch (error: any) {
    if (error?.code === 404) {
      console.log('No existing state file in GCS — starting fresh.');
    } else {
      console.error('Failed to load state from GCS:', error);
    }
  }
}

async function saveState(): Promise<void> {
  if (!googleCredentials) {
    return; // GOOGLE_CREDENTIALS not configured; state is in-memory only
  }
  try {
    await stateFile.save(JSON.stringify(agentState, null, 2), {
      contentType: 'application/json',
    });
  } catch (error) {
    console.error('Failed to save state to GCS:', error);
  }
}

const agentState = {
  studyId: null as string | null,
  studyStatus: 'not_started',
  submissionsReceived: 0,
  submissionsForwarded: 0,
  lastConvergenceCheck: null as object | null,
  lastAssignedParagraphId: 0,
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
    let taskState: 'completed' | 'failed' = 'completed';

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
            await saveState();
            result = {
              success: true,
              action,
              studyId,
              studyStatus: agentState.studyStatus,
              estimatedCostUsd: ((300 * 1.5) * 1.33).toFixed(2),
              estimatedCostNote:
                'Approx $' +
                ((300 * 1.5) * 1.33).toFixed(2) +
                ' USD including Prolific platform fee (~33%). Excludes any VAT.',
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
            await saveState();
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
          await saveState();
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
      taskState = 'failed';
      if (error instanceof ProlificConfigurationError) {
        result = {
          success: false,
          code: 'PROLIFIC_API_TOKEN_MISSING_OR_INVALID',
          error: error.message,
        };
      } else {
        result = {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }

    const responseEvent: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
      status: {
        state: taskState,
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

app.get('/api/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/api/study/status', async (_req, res) => {
  if (!agentState.studyId) {
    res.status(200).json({ agentState, prolific: null });
    return;
  }
  try {
    const [study, submissions] = await Promise.all([
      prolificClient.getStudy(agentState.studyId),
      prolificClient.getSubmissions(agentState.studyId),
    ]);
    const submissionCount = Array.isArray(submissions)
      ? submissions.length
      : Array.isArray((submissions as any).results)
        ? (submissions as any).results.length
        : 0;
    res.status(200).json({ agentState, prolific: { study, submissionCount } });
  } catch (error) {
    res.status(500).json({
      agentState,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/api/study/launch', express.json(), async (_req, res) => {
  if (agentState.studyId) {
    res.status(409).json({
      success: false,
      error: 'A study is already active. Close it before launching a new one.',
      studyId: agentState.studyId,
    });
    return;
  }
  try {
    const createdStudy = await prolificClient.createStudy();
    const studyId = (createdStudy.id ?? createdStudy.study_id) as string;
    await prolificClient.publishStudy(studyId);
    await prolificClient.registerWebhook(studyId);
    agentState.studyId = studyId;
    agentState.studyStatus = 'published';
    await saveState();
    res.status(200).json({
      success: true,
      studyId,
      studyStatus: agentState.studyStatus,
      estimatedCostUsd: ((300 * 1.5) * 1.33).toFixed(2),
      estimatedCostNote:
        'Approx $' +
        ((300 * 1.5) * 1.33).toFixed(2) +
        ' USD including Prolific platform fee (~33%). Excludes any VAT.',
    });
  } catch (error) {
    res.status(error instanceof ProlificConfigurationError ? 401 : 500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/api/study/close', express.json(), async (_req, res) => {
  if (!agentState.studyId) {
    res.status(404).json({ success: false, error: 'No active study to close.' });
    return;
  }
  try {
    const closeResponse = await prolificClient.closeStudy(agentState.studyId);
    agentState.studyStatus = 'closed';
    await saveState();
    res.status(200).json({
      success: true,
      studyId: agentState.studyId,
      studyStatus: agentState.studyStatus,
      closeResponse,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/api/convergence', async (_req, res) => {
  try {
    const convergence = await backendClient.getConvergenceStatus();
    agentState.lastConvergenceCheck = convergence;
    await saveState();
    res.status(200).json(convergence);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/webhook/prolific', express.json(), async (req, res) => {
  const { submission_id, participant_id } = req.body ?? {};
  agentState.submissionsReceived++;
  await saveState();
  console.log(`Prolific webhook: submission ${submission_id} from ${participant_id}`);
  res.status(200).json({ received: true });
  // PRODUCTION NOTE: On webhook receipt, look up submission_id in the GCS bucket
  // for a corresponding `${submission_id}.wav` file written by /submit. If found,
  // re-evaluate or reprocess as needed and persist refreshed sidecars to GCS.
  // In the current PoC, /submit does not yet write WAV files to GCS.
});

app.get('/record', async (req, res) => {
  const pid = String(req.query.pid ?? '');
  const studyId = String(req.query.study_id ?? '');
  const submissionId = String(req.query.submission_id ?? '');
  let paragraphId = 1;

  try {
    const paragraphCount = await backendClient.getParagraphCount().catch(() => 10);
    const assignedId = (agentState.lastAssignedParagraphId % paragraphCount) + 1;
    agentState.lastAssignedParagraphId = assignedId;
    await saveState();
    paragraphId = assignedId;
    // PRODUCTION NOTE: persist lastAssignedParagraphId to GCS after each assignment
    // and use an atomic compare-and-swap or a distributed lock to prevent duplicate
    // assignments under concurrent load.
  } catch (error) {
    console.error('Failed to fetch paragraph count', error);
  }

  let paragraphText = 'Paragraph text unavailable.';
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
    <p>Please record yourself reading this paragraph aloud:</p>
    <p id="paragraph"><strong>${escapedParagraph}</strong></p>
    <button id="record">Start recording</button>
    <button id="stop" disabled>Stop recording</button>
    <audio id="playback" controls style="display:none; margin-top: 0.5rem;"></audio>
    <button id="submit" disabled>Submit recording</button>
    <p id="status">Ready.</p>
    <div id="completion" style="display:none; margin-top: 1rem;">
      <a href="https://app.prolific.com/submissions/complete?cc=STRESS_DONE" target="_blank" rel="noopener noreferrer" style="font-size:1.2rem; font-weight:bold;">Complete on Prolific (STRESS_DONE)</a>
    </div>

    <script>
      const recordBtn = document.getElementById('record');
      const stopBtn = document.getElementById('stop');
      const submitBtn = document.getElementById('submit');
      const playback = document.getElementById('playback');
      const statusEl = document.getElementById('status');
      const completionEl = document.getElementById('completion');

      let mediaRecorder;
      let chunks = [];
      let audioBlob;

      function pcm16ToWavBlob(samples, sampleRate) {
        const bytesPerSample = 2;
        const blockAlign = bytesPerSample;
        const byteRate = sampleRate * blockAlign;
        const dataLength = samples.length * bytesPerSample;
        const buffer = new ArrayBuffer(44 + dataLength);
        const view = new DataView(buffer);

        const writeString = (offset, value) => {
          for (let i = 0; i < value.length; i++) {
            view.setUint8(offset + i, value.charCodeAt(i));
          }
        };

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + dataLength, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, dataLength, true);

        let offset = 44;
        for (let i = 0; i < samples.length; i++, offset += 2) {
          const sample = Math.max(-1, Math.min(1, samples[i]));
          view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        }

        return new Blob([buffer], { type: 'audio/wav' });
      }

      async function convertTo16kMonoWav(blob) {
        const arrayBuffer = await blob.arrayBuffer();
        const audioContext = new AudioContext();
        const decoded = await audioContext.decodeAudioData(arrayBuffer);
        // Close after we have finished reading decoded data. On Safari, closing the
        // AudioContext before all channel data has been consumed can cause the
        // getChannelData() calls below to return zeroed buffers. We defer close
        // until after the monoBuffer is fully populated.
        const channelSnapshots = [];
        for (let c = 0; c < decoded.numberOfChannels; c++) {
          channelSnapshots.push(new Float32Array(decoded.getChannelData(c)));
        }
        await audioContext.close();

        const targetRate = 16000;
        const offlineContext = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);
        const source = offlineContext.createBufferSource();

        const monoBuffer = offlineContext.createBuffer(1, decoded.length, decoded.sampleRate);
        const monoData = monoBuffer.getChannelData(0);
        for (let i = 0; i < decoded.length; i++) {
          let value = 0;
          for (let c = 0; c < channelSnapshots.length; c++) {
            value += channelSnapshots[c][i] || 0;
          }
          monoData[i] = value / channelSnapshots.length;
        }

        source.buffer = monoBuffer;
        source.connect(offlineContext.destination);
        source.start();
        const rendered = await offlineContext.startRendering();
        return pcm16ToWavBlob(rendered.getChannelData(0), targetRate);
      }

      recordBtn.onclick = async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        chunks = [];
        mediaRecorder.ondataavailable = (event) => chunks.push(event.data);
        mediaRecorder.onstop = async () => {
          const rawBlob = new Blob(chunks, { type: 'audio/webm' });
          audioBlob = await convertTo16kMonoWav(rawBlob);
          const audioUrl = URL.createObjectURL(audioBlob);
          playback.src = audioUrl;
          playback.style.display = 'block';
          submitBtn.disabled = false;
          statusEl.textContent = 'Recording captured. Listen before submitting.';
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
        formData.append('audio', audioBlob, 'recording.wav');

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
    await saveState();

    // TODO (production): persist WAV to GCS before forwarding to backend:
    // await gcsBucket.file(`${submissionId}.wav`).save(req.file.buffer,
    //   { contentType: 'audio/wav' });
    // await gcsBucket.file(`${submissionId}.json`).save(
    //   JSON.stringify({ pid, studyId, paragraphId, ...result }, null, 2),
    //   { contentType: 'application/json' });

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

loadState().then(() => {
  app.listen(port, () => {
    console.log(`NESHSEC agent listening on port ${port}`);
    console.log(`Agent card: ${serviceUrl}/.well-known/agent.json`);
    console.log(`JSON-RPC endpoint: ${serviceUrl}/a2a`);
    console.log(`Study status: ${serviceUrl}/api/study/status`);
    console.log(`GCS bucket: ${gcsBucketName}`);
  });
});
