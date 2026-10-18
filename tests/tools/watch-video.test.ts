import { afterEach, describe, expect, test } from 'bun:test';
import {
  GeminiRejectedError,
  type GeminiService,
  UpstreamError,
  type WatchOutcome,
  type WatchRequest,
} from '../../src/services/gemini';
import { parseYouTubeVideo } from '../../src/tools/watch-video';
import { cleanup, connect, fakeGemini, type LogEntry, testDeps, textOf, USAGE } from '../helpers';

afterEach(cleanup);

const ID = 'jNQXAC9IVRw';
const URL_ = `https://www.youtube.com/watch?v=${ID}`;

/** A fake Gemini that records each request and answers with `outcome` or throws `error`. */
function recording(answer: () => WatchOutcome | Promise<WatchOutcome> = () => completed()) {
  const requests: WatchRequest[] = [];
  const gemini: GeminiService = fakeGemini({
    watch: async (request) => {
      requests.push(request);
      return answer();
    },
  });
  return { gemini, requests };
}

const completed = (text = 'A man at the zoo.'): WatchOutcome => ({
  status: 'completed',
  interactionId: 'i-1',
  text,
  usage: USAGE,
});

async function watch(args: Record<string, unknown>, gemini: GeminiService = fakeGemini()) {
  const deps = testDeps({ gemini });
  const client = await connect({ deps });
  const result = await client.callTool({
    name: 'watch_video',
    arguments: { prompt: 'What happens?', ...args },
  });
  return { result, deps };
}

describe('watch_video', () => {
  test('answers in agentic mode by default, with the canonical URL and the token usage', async () => {
    const { gemini, requests } = recording();
    const { result, deps } = await watch({ video: `https://youtu.be/${ID}?si=share` }, gemini);

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('A man at the zoo.');
    expect(result.structuredContent).toEqual({
      videoId: ID,
      url: URL_,
      mode: 'agentic',
      model: 'gemini-test',
      answer: 'A man at the zoo.',
      usage: USAGE,
    });
    expect(requests).toEqual([
      { url: URL_, prompt: 'What happens?', processing: { mode: 'agentic' } },
    ]);
    // The prompt stays out of the logs.
    expect(deps.logs.map(({ level, message, fields }) => [level, message, fields])).toEqual([
      [
        'info',
        'Watched a video',
        { videoId: ID, mode: 'agentic', model: 'gemini-test', totalTokens: 3_030 },
      ],
    ]);
  });

  test('start, end and fps choose static mode', async () => {
    const { gemini, requests } = recording();
    const { result } = await watch({ video: ID, start: 60, end: 120, fps: 2 }, gemini);

    expect((result.structuredContent as { mode: string }).mode).toBe('static');
    expect(requests[0]?.processing).toEqual({
      mode: 'static',
      startSeconds: 60,
      endSeconds: 120,
      fps: 2,
    });
  });

  test('static mode can be chosen without a clip', async () => {
    const { gemini, requests } = recording();
    await watch({ video: ID, mode: 'static' }, gemini);

    expect(requests[0]?.processing).toEqual({ mode: 'static' });
  });

  test('refuses a clip in agentic mode, and an end before the start, without calling Gemini', async () => {
    const { gemini, requests } = recording();
    const agentic = await watch({ video: ID, mode: 'agentic', start: 10 }, gemini);
    const backwards = await watch({ video: ID, start: 90, end: 30 }, gemini);

    expect(agentic.result.isError).toBe(true);
    expect(textOf(agentic.result)).toContain('only in static mode');
    expect(backwards.result.isError).toBe(true);
    expect(textOf(backwards.result)).toBe('end (30) must be later than start (90).');
    expect(requests).toEqual([]);
  });

  test('refuses anything that is not a YouTube video, so Gemini never fetches it', async () => {
    const { gemini, requests } = recording();
    for (const video of [
      'https://vimeo.com/123',
      'not a video',
      'https://youtube.com.evil.example/watch?v=jNQXAC9IVRw',
    ]) {
      const { result } = await watch({ video }, gemini);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('is not a YouTube video');
    }
    expect(requests).toEqual([]);
  });

  test('a video Gemini cannot watch gets a hint, and the operator gets Gemini’s detail', async () => {
    const { gemini } = recording(() => ({
      status: 'failed',
      interactionId: 'i-9',
      code: 'PERMISSION_DENIED',
      message: 'There was a problem processing your request.',
    }));
    const { result, deps } = await watch({ video: ID }, gemini);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('must exist and be public');
    expect(deps.logs).toEqual([
      {
        level: 'warning',
        message: 'Gemini could not watch the video',
        fields: {
          videoId: ID,
          interactionId: 'i-9',
          code: 'PERMISSION_DENIED',
          detail: 'There was a problem processing your request.',
        },
      },
    ]);
  });

  test('every other outcome tells the model what to do next', async () => {
    const outcomes: Array<[WatchOutcome, string]> = [
      [completed(''), 'finished without an answer'],
      [{ status: 'incomplete', interactionId: 'i' }, 'Ask a narrower question'],
      [{ status: 'cancelled', interactionId: 'i' }, 'Try again'],
      [{ status: 'timeout', interactionId: 'i', waitedMs: 600_000 }, 'within 10 minutes'],
    ];
    for (const [outcome, hint] of outcomes) {
      const { result } = await watch({ video: ID }, recording(() => outcome).gemini);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(hint);
    }
  });

  test('Gemini’s refusals are explained to the model and logged for the operator', async () => {
    const cases: Array<[Error, string, LogEntry['level']]> = [
      [
        new GeminiRejectedError(400, 'INVALID_ARGUMENT', 'API_KEY_INVALID', 'API key not valid.'),
        'Tell the operator',
        'error',
      ],
      [
        new GeminiRejectedError(429, 'RESOURCE_EXHAUSTED', undefined, 'Quota exceeded.'),
        'quota',
        'warning',
      ],
      [
        new GeminiRejectedError(404, 'not_found', undefined, "Model 'x' not found."),
        'model that does not exist',
        'error',
      ],
      [
        new GeminiRejectedError(400, 'invalid_request', undefined, 'Bad prompt.'),
        'Gemini rejected the request: Bad prompt.',
        'warning',
      ],
      [new UpstreamError('Gemini', 503), 'Try again in a minute', 'warning'],
    ];
    for (const [error, hint, level] of cases) {
      const gemini = fakeGemini({
        watch: async () => {
          throw error;
        },
      });
      const { result, deps } = await watch({ video: ID }, gemini);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(hint);
      expect(deps.logs.map((entry) => entry.level)).toEqual([level]);
    }
  });

  test('an unexpected failure reaches the model only as a reference', async () => {
    const gemini = fakeGemini({
      watch: async () => {
        throw new Error('https://secret.example/?key=leak');
      },
    });
    const { result, deps } = await watch({ video: ID }, gemini);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('reference');
    expect(textOf(result)).not.toContain('leak');
    expect(deps.logs.map((entry) => entry.level)).toEqual(['error']);
  });

  test('forwards progress as seconds out of the time limit', async () => {
    const gemini = fakeGemini({
      watch: async (_request, _signal, onProgress) => {
        await onProgress?.({ elapsedMs: 0, partsLoaded: 0 });
        await onProgress?.({ elapsedMs: 4_200, partsLoaded: 1 });
        await onProgress?.({ elapsedMs: 9_000, partsLoaded: 3 });
        return completed();
      },
    });
    const client = await connect({ deps: testDeps({ gemini }) });
    const progress: unknown[] = [];
    await client.callTool(
      { name: 'watch_video', arguments: { video: ID, prompt: 'What happens?' } },
      { onprogress: ({ progress: done, total, message }) => progress.push([done, total, message]) },
    );

    expect(progress).toEqual([
      [0, 600, 'Watching the video'],
      [4, 600, 'Watching: 1 part of the video looked at'],
      [9, 600, 'Watching: 3 parts of the video looked at'],
    ]);
  });

  test('a cancelled call aborts the watch, and is logged as information, not as a failure', async () => {
    let upstreamSignal: AbortSignal | undefined;
    const gemini = fakeGemini({
      watch: (_request, signal) => {
        upstreamSignal = signal;
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });
    const deps = testDeps({ gemini });
    const client = await connect({ deps });
    const controller = new AbortController();

    const call = client.callTool(
      { name: 'watch_video', arguments: { video: ID, prompt: 'What happens?' } },
      { signal: controller.signal },
    );
    while (!upstreamSignal) await Bun.sleep(1);
    controller.abort('stop');

    await expect(call).rejects.toThrow();
    await Bun.sleep(10);
    expect(upstreamSignal.aborted).toBe(true);
    expect(deps.logs).toEqual([
      { level: 'info', message: 'The client cancelled a watch', fields: { videoId: ID } },
    ]);
  });
});

describe('parseYouTubeVideo', () => {
  test('finds the ID in every common URL form, and in a bare ID', () => {
    for (const input of [
      ID,
      ` ${ID}\n`,
      URL_,
      `https://youtube.com/watch?v=${ID}&t=90s&list=PL123`,
      `http://m.youtube.com/watch?v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}?t=12`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/live/${ID}?feature=share`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube-nocookie.com/embed/${ID}`,
      `www.youtube.com/watch?v=${ID}`,
      `youtu.be/${ID}`,
    ]) {
      expect([input, parseYouTubeVideo(input)]).toEqual([input, ID]);
    }
  });

  test('refuses other hosts, other paths, other schemes and malformed IDs', () => {
    for (const input of [
      'https://vimeo.com/123456',
      `https://youtube.com.evil.example/watch?v=${ID}`,
      `https://evil.example/?u=https://youtu.be/${ID}`,
      'https://www.youtube.com/@channel',
      'https://www.youtube.com/playlist?list=PL123',
      `https://www.youtube.com/watch?v=${ID}x`,
      'https://www.youtube.com/watch?v=short',
      `ftp://youtube.com/watch?v=${ID}`,
      `javascript:alert('${ID}')`,
      'jNQXAC9IVR!',
      '',
    ]) {
      expect([input, parseYouTubeVideo(input)]).toEqual([input, undefined]);
    }
  });
});
