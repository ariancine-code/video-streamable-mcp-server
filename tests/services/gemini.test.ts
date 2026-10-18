import { describe, expect, test } from 'bun:test';
import {
  createGeminiService,
  GeminiRejectedError,
  type GeminiServiceOptions,
  UpstreamError,
  type WatchProgress,
  type WatchRequest,
} from '../../src/services/gemini';

const BASE = 'https://gemini.test/v1beta';
const URL_ = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const AGENTIC: WatchRequest = {
  url: URL_,
  prompt: 'What happens?',
  processing: { mode: 'agentic' },
};

interface Recorded {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
  redirect: RequestInit['redirect'];
}

/**
 * A fetch that answers each request with the next response in `script`. Requests to the
 * cancel endpoint are recorded and answered without using the script.
 */
function scripted(script: Array<Response | (() => Response | Promise<Response>)>) {
  const requests: Recorded[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      method: init?.method ?? 'GET',
      url,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      redirect: init?.redirect,
    });
    if (url.endsWith('/cancel')) return Response.json({ id: 'i-1', status: 'cancelled' });
    const next = script.shift();
    if (!next) throw new Error(`Unexpected request: ${init?.method} ${url}`);
    return typeof next === 'function' ? next() : next;
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

/** The video part of the first request's input. */
function videoPart(requests: Recorded[]) {
  return (requests[0]?.body as { input?: Array<Record<string, unknown>> } | undefined)?.input?.[0];
}

function service(fetch: typeof globalThis.fetch, overrides: Partial<GeminiServiceOptions> = {}) {
  return createGeminiService({
    apiKey: 'secret-key',
    model: 'gemini-3.8-flash',
    baseUrl: `${BASE}/`,
    fetch,
    pollDelayMs: () => 0,
    ...overrides,
  });
}

const signal = () => new AbortController().signal;
const running = (status = 'in_progress', steps: unknown[] = []) =>
  Response.json({ id: 'i-1', status, steps });
const completed = (extra: Record<string, unknown> = {}) =>
  Response.json({
    id: 'i-1',
    status: 'completed',
    steps: [
      { type: 'user_input', content: [{ type: 'video' }, { type: 'text', text: 'What happens?' }] },
      { type: 'processing_call', id: 'c1' },
      { type: 'processing_result', call_id: 'c1' },
      { type: 'thought', signature: 's' },
      { type: 'model_output', content: [{ type: 'text', text: 'A man stands ' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'by the elephants.' }] },
    ],
    usage: {
      total_input_tokens: 92,
      total_output_tokens: 101,
      total_thought_tokens: 301,
      total_tool_use_tokens: 2657,
      total_tokens: 3151,
    },
    ...extra,
  });

describe('gemini service', () => {
  test('starts a background interaction with the key in a header, then polls it', async () => {
    const { fetch, requests } = scripted([running(), running(), completed()]);
    const outcome = await service(fetch).watch(AGENTIC, signal());

    expect(outcome).toEqual({
      status: 'completed',
      interactionId: 'i-1',
      text: 'A man stands by the elephants.',
      usage: {
        inputTokens: 92,
        outputTokens: 101,
        thoughtTokens: 301,
        toolUseTokens: 2657,
        totalTokens: 3151,
      },
    });
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST ${BASE}/interactions`,
      `GET ${BASE}/interactions/i-1`,
      `GET ${BASE}/interactions/i-1`,
    ]);
    const [create] = requests;
    expect(create?.body).toEqual({
      model: 'gemini-3.8-flash',
      background: true,
      input: [
        { type: 'video', uri: URL_, processing: 'agentic' },
        { type: 'text', text: 'What happens?' },
      ],
    });
    for (const request of requests) {
      expect(request.headers.get('x-goog-api-key')).toBe('secret-key');
      expect(request.url).not.toContain('secret-key');
      // workerd refuses 'error'; 'manual' keeps the key header off a redirect target.
      expect(request.redirect).toBe('manual');
    }
  });

  test('static mode sends offsets as duration strings, which the API requires', async () => {
    const { fetch, requests } = scripted([completed()]);
    await service(fetch).watch(
      { ...AGENTIC, processing: { mode: 'static', startSeconds: 0, endSeconds: 90, fps: 0.5 } },
      signal(),
    );

    expect(videoPart(requests)).toEqual({
      type: 'video',
      uri: URL_,
      processing: { type: 'static', start_offset: '0s', end_offset: '90s', fps: 0.5 },
    });
  });

  test('plain static mode sends only the type', async () => {
    const { fetch, requests } = scripted([completed()]);
    await service(fetch).watch({ ...AGENTIC, processing: { mode: 'static' } }, signal());

    expect(videoPart(requests)?.processing).toEqual({
      type: 'static',
    });
  });

  test('reports progress before each poll, counting the parts of the video loaded', async () => {
    let clock = 0;
    const { fetch } = scripted([
      Response.json({ id: 'i-1', status: 'queued' }),
      running('in_progress', [{ type: 'processing_result' }]),
      running('in_progress', [{ type: 'processing_result' }, { type: 'processing_result' }]),
      completed(),
    ]);
    const progress: WatchProgress[] = [];
    await service(fetch, {
      now: () => clock,
      pollDelayMs: () => {
        clock += 2_000;
        return 0;
      },
    }).watch(AGENTIC, signal(), (update) => {
      progress.push(update);
    });

    expect(progress).toEqual([
      { elapsedMs: 0, partsLoaded: 0 },
      { elapsedMs: 2_000, partsLoaded: 1 },
      { elapsedMs: 4_000, partsLoaded: 2 },
    ]);
  });

  test('a failed interaction is an outcome with Gemini’s code and message', async () => {
    const { fetch } = scripted([
      running(),
      Response.json({
        id: 'i-1',
        status: 'failed',
        errors: [{ code: 'PERMISSION_DENIED', message: 'There was a problem.' }],
      }),
    ]);

    expect(await service(fetch).watch(AGENTIC, signal())).toEqual({
      status: 'failed',
      interactionId: 'i-1',
      code: 'PERMISSION_DENIED',
      message: 'There was a problem.',
    });
  });

  test('incomplete and cancelled interactions are outcomes', async () => {
    for (const status of ['incomplete', 'cancelled'] as const) {
      const { fetch } = scripted([Response.json({ id: 'i-1', status })]);
      expect(await service(fetch).watch(AGENTIC, signal())).toEqual({
        status,
        interactionId: 'i-1',
      });
    }
  });

  test('gives up after maxWaitMs and cancels the interaction', async () => {
    let clock = 0;
    const { fetch, requests } = scripted([running(), running(), running()]);
    const outcome = await service(fetch, {
      maxWaitMs: 10_000,
      now: () => clock,
      pollDelayMs: () => {
        clock += 6_000;
        return 0;
      },
    }).watch(AGENTIC, signal());

    expect(outcome).toEqual({ status: 'timeout', interactionId: 'i-1', waitedMs: 12_000 });
    expect(requests.at(-1)?.url).toBe(`${BASE}/interactions/i-1/cancel`);
  });

  test('a cancelled call stops polling and cancels the interaction', async () => {
    const controller = new AbortController();
    const { fetch, requests } = scripted([running()]);
    const watch = service(fetch, { pollDelayMs: () => 60_000 }).watch(AGENTIC, controller.signal);
    while (requests.length === 0) await Bun.sleep(1);
    controller.abort(new Error('stop'));

    await expect(watch).rejects.toThrow('stop');
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST ${BASE}/interactions`,
      `POST ${BASE}/interactions/i-1/cancel`,
    ]);
    // The cancel request must not carry the aborted signal, or it would never be sent.
    expect(requests[1]?.headers.get('x-goog-api-key')).toBe('secret-key');
  });

  test('the cancel is handed to keepAlive, so it completes after the client has gone', async () => {
    const controller = new AbortController();
    const { fetch, requests } = scripted([running()]);
    const kept: Array<Promise<unknown>> = [];
    const watch = service(fetch, {
      pollDelayMs: () => 60_000,
      keepAlive: (promise) => kept.push(promise),
    }).watch(AGENTIC, controller.signal);
    while (requests.length === 0) await Bun.sleep(1);
    controller.abort(new Error('gone'));

    await expect(watch).rejects.toThrow('gone');
    expect(kept).toHaveLength(1);
    // It never rejects: a failed cancel must not surface as an unhandled rejection.
    await expect(kept[0]).resolves.toBeUndefined();
  });

  test('a failed poll cancels the interaction before the error reaches the caller', async () => {
    const { fetch, requests } = scripted([running(), new Response('busy', { status: 503 })]);

    await expect(service(fetch).watch(AGENTIC, signal())).rejects.toBeInstanceOf(UpstreamError);
    expect(requests.at(-1)?.url).toBe(`${BASE}/interactions/i-1/cancel`);
  });

  test('an invalid key, answered in Google’s array shape, is a rejected key', async () => {
    const { fetch } = scripted([
      Response.json(
        [
          {
            error: {
              code: 400,
              message: 'API key not valid. Please pass a valid API key.',
              status: 'INVALID_ARGUMENT',
              details: [{ '@type': 'ErrorInfo', reason: 'API_KEY_INVALID' }],
            },
          },
        ],
        { status: 400 },
      ),
    ]);
    const error = await service(fetch)
      .watch(AGENTIC, signal())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GeminiRejectedError);
    expect(error).toMatchObject({
      status: 400,
      code: 'INVALID_ARGUMENT',
      reason: 'API_KEY_INVALID',
      detail: 'API key not valid. Please pass a valid API key.',
      isKeyProblem: true,
    });
  });

  test('an unknown model, answered in the Interactions shape, is a rejection', async () => {
    const { fetch } = scripted([
      Response.json(
        { error: { message: "Model 'gemini-nope' not found.", code: 'not_found' } },
        { status: 404 },
      ),
    ]);
    const error = await service(fetch)
      .watch(AGENTIC, signal())
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 404, code: 'not_found', isKeyProblem: false });
  });

  test('a rejection without a readable body still carries its status', async () => {
    const { fetch } = scripted([new Response('Too many requests', { status: 429 })]);
    const error = await service(fetch)
      .watch(AGENTIC, signal())
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 429, code: undefined, detail: undefined });
  });

  test('server errors, redirects and network failures are outages', async () => {
    const answers = [
      () => new Response('down', { status: 502 }),
      () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.test' } }),
      () => {
        throw new TypeError('fetch failed');
      },
    ];
    for (const answer of answers) {
      const { fetch } = scripted([answer]);
      await expect(service(fetch).watch(AGENTIC, signal())).rejects.toBeInstanceOf(UpstreamError);
    }
  });

  test('a stalled response times out as an outage', async () => {
    const fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })) as typeof globalThis.fetch;

    await expect(
      service(fetch, { requestTimeoutMs: 10 }).watch(AGENTIC, signal()),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  test('a complete response in the wrong shape is a bug, not an outage', async () => {
    const { fetch } = scripted([Response.json({ unexpected: true })]);
    const error = await service(fetch)
      .watch(AGENTIC, signal())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UpstreamError);
  });

  test('an unknown status is a bug, and the interaction is cancelled', async () => {
    const { fetch, requests } = scripted([Response.json({ id: 'i-1', status: 'requires_action' })]);

    await expect(service(fetch).watch(AGENTIC, signal())).rejects.toThrow('requires_action');
    expect(requests.at(-1)?.url).toBe(`${BASE}/interactions/i-1/cancel`);
  });
});
