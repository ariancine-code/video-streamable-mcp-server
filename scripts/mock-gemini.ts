import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A loopback stand-in for the Gemini Interactions API, for the smoke tests. It answers only
 * requests that carry `apiKey` in the `x-goog-api-key` header, and it refuses what the real
 * API refuses: numeric clip offsets. Each interaction is `in_progress` when created and
 * `completed` on the first poll, with an answer naming the video and its processing, unless
 * the prompt is `hang`: that one stays `in_progress` until it is cancelled. Bun and Node both
 * run this file.
 */
export interface GeminiMock {
  /** Use as GEMINI_API_URL. */
  url: string;
  /** Every request, as `METHOD path`, in order. */
  requests: string[];
  /** Resolves once some interaction is cancelled; rejects after `timeoutMs`. */
  cancelled(timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

interface VideoInput {
  type: string;
  uri?: string;
  processing?: unknown;
}

interface Stored {
  video: VideoInput;
  hang: boolean;
  status: 'in_progress' | 'cancelled';
}

const DURATION = /^\d+(\.\d+)?s$/;

/** The real API rejects `start_offset: 90`; it wants `"90s"` (checked 2026-10-18). */
function validProcessing(processing: unknown): boolean {
  if (processing === 'agentic' || processing === 'static') return true;
  if (!processing || typeof processing !== 'object') return false;
  const { type, start_offset, end_offset } = processing as Record<string, unknown>;
  return (
    type === 'static' &&
    [start_offset, end_offset].every(
      (offset) => offset === undefined || (typeof offset === 'string' && DURATION.test(offset)),
    )
  );
}

export async function startGeminiMock(apiKey: string): Promise<GeminiMock> {
  const requests: string[] = [];
  const interactions = new Map<string, Stored>();

  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requests.push(`${request.method} ${path}`);
    const send = (status: number, body: unknown) => {
      response.statusCode = status;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(body));
    };

    if (request.headers['x-goog-api-key'] !== apiKey) {
      return send(400, [
        {
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message: 'API key not valid.',
            details: [{ reason: 'API_KEY_INVALID' }],
          },
        },
      ]);
    }

    if (request.method === 'POST' && path === '/v1beta/interactions') {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw) as {
        background?: boolean;
        input?: Array<VideoInput & { text?: string }>;
      };
      const video = body.input?.find((input) => input.type === 'video');
      const prompt = body.input?.find((input) => input.type === 'text')?.text;
      if (!body.background || !video?.uri || !validProcessing(video.processing)) {
        return send(400, {
          error: { message: "Invalid input at 'input[0].processing'.", code: 'invalid_request' },
        });
      }
      const id = `smoke-${interactions.size + 1}`;
      interactions.set(id, { video, hang: prompt === 'hang', status: 'in_progress' });
      return send(200, { id, status: 'in_progress', object: 'interaction' });
    }

    const match = /^\/v1beta\/interactions\/([^/]+)(\/cancel)?$/.exec(path);
    const stored = match?.[1] ? interactions.get(match[1]) : undefined;
    if (!match || !stored) return send(404, { error: { message: 'Not found', code: 'not_found' } });
    if (match[2]) {
      stored.status = 'cancelled';
      return send(200, { id: match[1], status: 'cancelled' });
    }
    if (stored.hang || stored.status === 'cancelled') {
      return send(200, { id: match[1], status: stored.status });
    }
    const { video } = stored;
    return send(200, {
      id: match[1],
      status: 'completed',
      steps: [
        { type: 'user_input', content: [{ type: 'video' }, { type: 'text', text: 'question' }] },
        {
          type: 'model_output',
          content: [
            { type: 'text', text: `Watched ${video.uri} (${JSON.stringify(video.processing)}).` },
          ],
        },
      ],
      usage: { total_input_tokens: 10, total_output_tokens: 5, total_tokens: 15 },
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1beta`,
    requests,
    cancelled: async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (!requests.some((request) => request.endsWith('/cancel'))) {
        if (Date.now() > deadline)
          throw new Error(`No interaction was cancelled within ${timeoutMs} ms`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
