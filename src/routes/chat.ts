import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ChatCompletionRequest, ChatCompletionChunk, ChatCompletion } from '../types';
import { convertMessages } from '../claude/message-converter';
import { sessionManager } from '../session/manager';

export const chatRouter = Router();

const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS ?? '120000', 10);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCompletionId(): string {
  return 'chatcmpl-' + uuidv4().replace(/-/g, '').slice(0, 12);
}

function makeChunk(
  id: string,
  model: string,
  delta: { role?: string; content?: string },
  finishReason: string | null,
): string {
  const chunk: ChatCompletionChunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function errorJson(type: string, message: string) {
  return { error: { type, message } };
}

// ─── Route handler ────────────────────────────────────────────────────────────

chatRouter.post('/chat/completions', async (req: Request, res: Response) => {
  const body = req.body as ChatCompletionRequest;

  // Validate
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json(errorJson('invalid_request_error', 'messages must be a non-empty array'));
    return;
  }

  let parsed: ReturnType<typeof convertMessages>;
  try {
    parsed = convertMessages(body.messages);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json(errorJson('invalid_request_error', msg));
    return;
  }

  const isStreaming = body.stream === true;
  const model = body.model ?? 'claude-code';
  const completionId = makeCompletionId();
  const requestedSessionId = req.headers['x-session-id'] as string | undefined;

  console.log(`[${new Date().toISOString()}] POST /v1/chat/completions` +
    ` | model=${model} stream=${isStreaming}` +
    (requestedSessionId ? ` | session=${requestedSessionId}` : ' | session=new'));
  console.log(`  prompt: ${parsed.prompt.slice(0, 200)}${parsed.prompt.length > 200 ? '…' : ''}`);

  // Acquire session
  let session: Awaited<ReturnType<typeof sessionManager.getOrCreate>>['session'];
  let isNewSession: boolean;

  try {
    const result = await sessionManager.getOrCreate(requestedSessionId);
    session = result.session;
    isNewSession = result.isNew;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to start Claude Code';
    const isMissing = msg.toLowerCase().includes('enoent') || msg.toLowerCase().includes('not found');
    const status = isMissing ? 503 : 500;

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      res.write(makeChunk(completionId, model, { content: `[Error] ${msg}` }, null));
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.status(status).json(errorJson('server_error', msg));
    }
    return;
  }

  // Always expose the session ID so clients can reuse it
  res.setHeader('X-Session-Id', session.id);

  if (isStreaming) {
    await handleStreaming(req, res, session, parsed.prompt, model, completionId);
  } else {
    await handleNonStreaming(res, session, parsed.prompt, model, completionId);
  }
});

// ─── Streaming handler ────────────────────────────────────────────────────────

async function handleStreaming(
  req: Request,
  res: Response,
  session: Awaited<ReturnType<typeof sessionManager.getOrCreate>>['session'],
  prompt: string,
  model: string,
  completionId: string,
): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  let firstChunk = true;
  let done = false;

  const finish = (finishReason = 'stop') => {
    if (done) return;
    done = true;
    res.write(makeChunk(completionId, model, {}, finishReason));
    res.write('data: [DONE]\n\n');
    res.end();
  };

  // Client disconnect: session stays alive for reuse; no kill needed
  req.on('close', () => {
    done = true;
  });

  session.sendMessage({
    prompt,
    timeoutMs: CLAUDE_TIMEOUT_MS,
    onChunk: (text) => {
      if (done) return;
      const delta = firstChunk
        ? { role: 'assistant', content: text }
        : { content: text };
      firstChunk = false;
      res.write(makeChunk(completionId, model, delta, null));
    },
    onDone: () => finish('stop'),
    onError: (err) => {
      if (done) return;
      // Send the error as a content chunk so the client sees it
      if (firstChunk) {
        res.write(makeChunk(completionId, model, { role: 'assistant', content: `[Error] ${err.message}` }, null));
        firstChunk = false;
      }
      finish('stop');
    },
  });
}

// ─── Non-streaming handler ────────────────────────────────────────────────────

async function handleNonStreaming(
  res: Response,
  session: Awaited<ReturnType<typeof sessionManager.getOrCreate>>['session'],
  prompt: string,
  model: string,
  completionId: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const chunks: string[] = [];

    session.sendMessage({
      prompt,
      timeoutMs: CLAUDE_TIMEOUT_MS,
      onChunk: (text) => chunks.push(text),
      onDone: () => {
        const content = chunks.join('').trim();
        const response: ChatCompletion = {
          id: completionId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          }],
          usage: {
            // PTY mode has no token count — report 0
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        };
        res.json(response);
        resolve();
      },
      onError: (err) => {
        const isMissing = err.message.toLowerCase().includes('enoent');
        const isTimeout = err.message.toLowerCase().includes('timeout');
        const status = isMissing ? 503 : isTimeout ? 504 : 500;
        res.status(status).json(errorJson('server_error', err.message));
        resolve();
      },
    });
  });
}
