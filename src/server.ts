import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AgentCard, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import {
  AgentExecutor,
  DefaultRequestHandler,
  ExecutionEventBus,
  InMemoryTaskStore,
  RequestContext,
} from '@a2a-js/sdk/server';
import { UserBuilder, agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';

class HelloWorldExecutor implements AgentExecutor {
  public async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
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
          parts: [{ kind: 'text', text: 'Hello from the A2A TypeScript hello world agent!' }],
        },
      },
      final: true,
    };

    eventBus.publish(responseEvent);
  }

  public async cancelTask(): Promise<void> {
    // No-op for hello world implementation.
  }
}

const port = Number(process.env.PORT ?? 8080);
const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`;

const agentCard: AgentCard = {
  name: 'A2A TypeScript Hello World',
  description: 'Minimal self-contained A2A hello world agent for Cloud Run.',
  url: baseUrl,
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
      id: 'hello_world',
      name: 'hello_world',
      description: 'Returns a hello world response.',
      tags: ['hello-world'],
      examples: ['hello'],
      inputModes: ['text'],
      outputModes: ['text'],
    },
  ],
  supportsAuthenticatedExtendedCard: false,
};

const app = express();
const requestHandler = new DefaultRequestHandler(
  agentCard,
  new InMemoryTaskStore(),
  new HelloWorldExecutor()
);

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/.well-known/agent.json', agentCardHandler({ agentCardProvider: requestHandler }));
app.use('/a2a', jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
app.use('/', jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

app.listen(port, () => {
  console.log(`A2A hello world agent listening on port ${port}`);
  console.log(`Agent card: ${baseUrl}/.well-known/agent.json`);
  console.log(`JSON-RPC endpoint: ${baseUrl}/a2a`);
});
