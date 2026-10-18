import * as z from 'zod/v4';

/**
 * Gemini Interactions API client (https://ai.google.dev/api/interactions-api), for watching
 * YouTube videos.
 *
 * A watch is a background interaction: one request starts it, then the service polls it
 * until it finishes. Polling keeps every upstream request short, so no connection has to
 * stay open while Gemini works, and progress can be reported between polls. If the caller
 * gives up (cancellation or `maxWaitMs`), the service cancels the interaction, so Gemini
 * stops working on it.
 *
 * Services know nothing about MCP. They take an `AbortSignal`, validate every response, and
 * throw `UpstreamError` when Gemini is down, slow or failing, and `GeminiRejectedError` when
 * it refuses a request. The API key comes from `Config` and travels in the
 * `x-goog-api-key` header only, never in a URL.
 */
export interface GeminiService {
  /** The model every watch uses. */
  readonly model: string;
  /** How long a watch may run before it is cancelled. */
  readonly maxWaitMs: number;
  watch(request: WatchRequest, signal: AbortSignal, onProgress?: OnProgress): Promise<WatchOutcome>;
}

export interface WatchRequest {
  /** A canonical YouTube URL: https://www.youtube.com/watch?v=<id>. */
  url: string;
  prompt: string;
  processing: Processing;
}

/**
 * Agentic: the model reads the transcript first and loads only the parts of the video it
 * needs. Static: frames at a fixed rate across the whole clip, which can be cut and sampled.
 */
export type Processing =
  | { mode: 'agentic' }
  | { mode: 'static'; startSeconds?: number; endSeconds?: number; fps?: number };

export interface WatchProgress {
  elapsedMs: number;
  /** Parts of the video (transcript, frames or audio) loaded so far. Agentic mode only. */
  partsLoaded: number;
}

export type OnProgress = (progress: WatchProgress) => Promise<void> | void;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  toolUseTokens: number;
  totalTokens: number;
}

/** How a watch ended. Failures that are about the video, not the service, are outcomes. */
export type WatchOutcome =
  | { status: 'completed'; interactionId: string; text: string; usage: Usage }
  /** Gemini couldn't process the video, for example a private or missing one. */
  | { status: 'failed'; interactionId: string; code?: string; message?: string }
  /** The output token limit was reached before the answer was finished. */
  | { status: 'incomplete'; interactionId: string }
  /** Cancelled on Gemini's side, not by this service. */
  | { status: 'cancelled'; interactionId: string }
  /** Not finished within `maxWaitMs`; the interaction was cancelled. */
  | { status: 'timeout'; interactionId: string; waitedMs: number };

/** The provider failed: an HTTP error status, a timeout, or a network failure. */
export class UpstreamError extends Error {
  constructor(
    readonly service: string,
    readonly status: number | undefined,
    options?: ErrorOptions,
  ) {
    super(
      status === undefined ? `${service} did not respond` : `${service} responded with ${status}`,
      options,
    );
    this.name = 'UpstreamError';
  }
}

/** Gemini refused the request: a bad key, an unknown model, an invalid argument, a quota. */
export class GeminiRejectedError extends Error {
  constructor(
    readonly status: number,
    /** `invalid_request`, `not_found`, `INVALID_ARGUMENT`, … when Gemini says. */
    readonly code: string | undefined,
    /** Machine-readable cause, such as `API_KEY_INVALID`, when Gemini says. */
    readonly reason: string | undefined,
    /** Gemini's own explanation. It names no credentials, but treat it as upstream text. */
    readonly detail: string | undefined,
  ) {
    super(`Gemini rejected the request with ${status}${code ? ` (${code})` : ''}`);
    this.name = 'GeminiRejectedError';
  }

  /** The API key is missing, wrong or not allowed to use the API. */
  get isKeyProblem(): boolean {
    return (
      this.status === 401 ||
      this.status === 403 ||
      this.reason === 'API_KEY_INVALID' ||
      this.reason === 'API_KEY_SERVICE_BLOCKED'
    );
  }
}

export interface GeminiServiceOptions {
  apiKey: string;
  model: string;
  /** Up to and including the version, e.g. https://generativelanguage.googleapis.com/v1beta */
  baseUrl: string;
  /** Injected in tests. Defaults to the runtime's `fetch`. */
  fetch?: typeof fetch;
  /** Upper bound per HTTP request, including reading the response, on top of cancellation. */
  requestTimeoutMs?: number;
  /** How long a watch may run before it is cancelled. */
  maxWaitMs?: number;
  /** Delay before poll number `attempt` (0-based). */
  pollDelayMs?: (attempt: number) => number;
  /** Injected in tests. */
  now?: () => number;
  /**
   * Keeps a promise running after the caller's request has ended, so cancelling an abandoned
   * interaction completes even when the client has disconnected. Workers' `waitUntil`.
   */
  keepAlive?: (promise: Promise<unknown>) => void;
}

export const DEFAULT_MAX_WAIT_MS = 10 * 60_000;

/** Short videos finish in seconds, so poll quickly at first, then settle. */
function defaultPollDelay(attempt: number): number {
  return attempt < 3 ? 2_000 : 5_000;
}

const TERMINAL = new Set(['completed', 'failed', 'incomplete', 'cancelled']);

const Interaction = z.object({
  id: z.string(),
  // A string, not an enum: a status added later reaches the tool as a bug, not a parse error.
  status: z.string(),
  steps: z
    .array(
      z.object({
        type: z.string(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
      }),
    )
    .default([]),
  usage: z
    .object({
      total_input_tokens: z.number().default(0),
      total_output_tokens: z.number().default(0),
      total_thought_tokens: z.number().default(0),
      total_tool_use_tokens: z.number().default(0),
      total_tokens: z.number().default(0),
    })
    .optional(),
  errors: z
    .array(z.object({ code: z.string().optional(), message: z.string().optional() }))
    .optional(),
});
type Interaction = z.infer<typeof Interaction>;

/**
 * Gemini answers errors in two shapes: `{ error }` from the Interactions API, and
 * `[{ error }]` from Google's front end (an invalid key, for example).
 */
const GoogleError = z.object({
  error: z.object({
    code: z.union([z.string(), z.number()]).optional(),
    status: z.string().optional(),
    message: z.string().optional(),
    details: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});
const ErrorBody = z.union([GoogleError, z.array(GoogleError).min(1)]);

export function createGeminiService(options: GeminiServiceOptions): GeminiService {
  const fetchImpl = options.fetch ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const pollDelayMs = options.pollDelayMs ?? defaultPollDelay;
  const now = options.now ?? Date.now;
  const base = options.baseUrl.replace(/\/+$/, '');

  async function call(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Interaction> {
    let response: Response;
    let payload: unknown;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          'x-goog-api-key': options.apiKey,
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        // workerd refuses 'error'. 'manual' also keeps the key header off a redirect target.
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
      });
      payload = await response.json().catch(() => undefined);
    } catch (error) {
      // Cancelled by the caller: pass it on unchanged.
      if (signal.aborted) throw error;
      // A network failure, a timeout, or a body cut off in transit.
      throw new UpstreamError('Gemini', undefined, { cause: error });
    }

    if (response.ok) {
      // A complete response in an unexpected shape is a bug to fix, not an outage: let it throw.
      return Interaction.parse(payload);
    }
    if (response.status >= 500 || response.status < 400) {
      throw new UpstreamError('Gemini', response.status);
    }
    const parsed = ErrorBody.safeParse(payload);
    const error = parsed.success
      ? (Array.isArray(parsed.data) ? parsed.data[0] : parsed.data)?.error
      : undefined;
    throw new GeminiRejectedError(
      response.status,
      error?.status ?? (typeof error?.code === 'string' ? error.code : undefined),
      error?.details?.find((detail) => detail.reason)?.reason,
      error?.message,
    );
  }

  /** Best effort: the watch is already over for the caller, so a failure here changes nothing. */
  function cancel(id: string): Promise<void> {
    const path = `/interactions/${encodeURIComponent(id)}/cancel`;
    const cancelled = call('POST', path, undefined, AbortSignal.timeout(5_000)).then(
      () => {},
      () => {},
    );
    options.keepAlive?.(cancelled);
    return cancelled;
  }

  return {
    model: options.model,
    maxWaitMs,

    async watch(request, signal, onProgress) {
      const started = now();
      let interaction = await call(
        'POST',
        '/interactions',
        {
          model: options.model,
          // Background: Gemini keeps working without an open connection; see the module comment.
          background: true,
          // Video first, then the question: Gemini answers best in that order.
          input: [
            { type: 'video', uri: request.url, processing: toProcessing(request.processing) },
            { type: 'text', text: request.prompt },
          ],
        },
        signal,
      );
      const { id } = interaction;

      try {
        for (let attempt = 0; !TERMINAL.has(interaction.status); attempt++) {
          if (interaction.status !== 'in_progress' && interaction.status !== 'queued') {
            throw new Error(
              `Gemini interaction ${id} has the unexpected status ${interaction.status}`,
            );
          }
          const elapsedMs = now() - started;
          if (elapsedMs >= maxWaitMs) {
            await cancel(id);
            return { status: 'timeout', interactionId: id, waitedMs: elapsedMs };
          }
          await onProgress?.({ elapsedMs, partsLoaded: countParts(interaction) });
          await sleep(Math.min(pollDelayMs(attempt), maxWaitMs - elapsedMs), signal);
          interaction = await call(
            'GET',
            `/interactions/${encodeURIComponent(id)}`,
            undefined,
            signal,
          );
        }
      } catch (error) {
        // The caller gave up, or polling failed: don't leave Gemini working (and billing) alone.
        await cancel(id);
        throw error;
      }

      switch (interaction.status) {
        case 'completed':
          return {
            status: 'completed',
            interactionId: id,
            text: outputText(interaction),
            usage: toUsage(interaction.usage),
          };
        case 'failed': {
          const [first] = interaction.errors ?? [];
          return {
            status: 'failed',
            interactionId: id,
            ...(first?.code && { code: first.code }),
            ...(first?.message && { message: first.message }),
          };
        }
        case 'incomplete':
          return { status: 'incomplete', interactionId: id };
        default:
          return { status: 'cancelled', interactionId: id };
      }
    },
  };
}

/**
 * The `processing` field of a video input. Offsets are duration strings ("90s"): the API
 * rejects plain numbers, although its documentation shows them (checked 2026-10-18).
 */
function toProcessing(processing: Processing): unknown {
  if (processing.mode === 'agentic') return 'agentic';
  const { startSeconds, endSeconds, fps } = processing;
  return {
    type: 'static',
    ...(startSeconds !== undefined && { start_offset: `${startSeconds}s` }),
    ...(endSeconds !== undefined && { end_offset: `${endSeconds}s` }),
    ...(fps !== undefined && { fps }),
  };
}

/** The answer: the text of every model output step. A stored interaction also echoes the input. */
function outputText(interaction: Interaction): string {
  return interaction.steps
    .filter((step) => step.type === 'model_output')
    .flatMap((step) => step.content ?? [])
    .flatMap((content) => (content.type === 'text' && content.text ? [content.text] : []))
    .join('')
    .trim();
}

function countParts(interaction: Interaction): number {
  return interaction.steps.filter((step) => step.type === 'processing_result').length;
}

function toUsage(usage: Interaction['usage']): Usage {
  return {
    inputTokens: usage?.total_input_tokens ?? 0,
    outputTokens: usage?.total_output_tokens ?? 0,
    thoughtTokens: usage?.total_thought_tokens ?? 0,
    toolUseTokens: usage?.total_tool_use_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
