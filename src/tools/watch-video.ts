import * as z from 'zod/v4';
import type { Logger } from '../platform/logger';
import { defineTool, reportProgress, toolError } from '../platform/primitives';
import { GeminiRejectedError, type Processing, UpstreamError } from '../services/gemini';

const Mode = z.enum(['agentic', 'static']);

const WatchOutput = z.object({
  videoId: z.string(),
  url: z.string().describe('The canonical URL of the video that was watched'),
  mode: Mode,
  model: z.string().describe('The Gemini model that watched it'),
  answer: z.string(),
  usage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      thoughtTokens: z.number(),
      toolUseTokens: z.number().describe('Video, audio and transcript loaded in agentic mode'),
      totalTokens: z.number(),
    })
    .describe('Gemini tokens billed for this call'),
});

/**
 * Watches a public YouTube video with Gemini and answers a question about it, from what is
 * seen and what is heard.
 */
export const watchVideo = defineTool(
  'watch_video',
  {
    title: 'Watch a YouTube video',
    description:
      'Watch a public YouTube video and answer a question about it: summarize it, find a ' +
      'moment, read what is on screen, describe what happens, or check what someone said. ' +
      'Gemini watches the frames and listens to the audio. Takes from seconds to a few ' +
      'minutes, depending on the video and the question. Private, unlisted and age-restricted ' +
      'videos cannot be watched.',
    inputSchema: z.object({
      video: z
        .string()
        .min(1)
        .max(2_048)
        .describe('The video: a youtube.com or youtu.be URL, or its 11-character video ID'),
      prompt: z
        .string()
        .min(1)
        .max(10_000)
        .describe(
          'What to find out: a question, or what to summarize, describe or extract. ' +
            'Refer to moments as MM:SS, e.g. "What is on the slide at 12:30?"',
        ),
      mode: Mode.optional().describe(
        'agentic (the default): Gemini reads the transcript first and looks only at the parts ' +
          'it needs; best for long videos and specific questions. static: frames at a fixed ' +
          'rate over the whole clip; best for short clips and visual detail. start, end and ' +
          'fps need static, and choose it when mode is left out.',
      ),
      start: z
        .number()
        .int()
        .min(0)
        .max(86_400)
        .optional()
        .describe('Static mode: where to start watching, in seconds from the beginning'),
      end: z
        .number()
        .int()
        .min(1)
        .max(86_400)
        .optional()
        .describe('Static mode: where to stop watching, in seconds from the beginning'),
      fps: z
        .number()
        .min(0.1)
        .max(30)
        .optional()
        .describe(
          'Static mode: frames per second to look at (default 1). Lower it for talks and ' +
            'slides, raise it for fast action',
        ),
    }),
    outputSchema: WatchOutput,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ video, prompt, mode, start, end, fps }, ctx, { gemini, logger }) => {
    const videoId = parseYouTubeVideo(video);
    if (!videoId) {
      return toolError(
        `"${video.slice(0, 100)}" is not a YouTube video. Pass a youtube.com or youtu.be URL, ` +
          'or an 11-character video ID.',
      );
    }
    const clipped = start !== undefined || end !== undefined || fps !== undefined;
    const chosen = mode ?? (clipped ? 'static' : 'agentic');
    if (chosen === 'agentic' && clipped) {
      return toolError('start, end and fps work only in static mode. Set mode to "static".');
    }
    if (start !== undefined && end !== undefined && end <= start) {
      return toolError(`end (${end}) must be later than start (${start}).`);
    }

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const processing: Processing =
      chosen === 'agentic'
        ? { mode: 'agentic' }
        : {
            mode: 'static',
            ...(start !== undefined && { startSeconds: start }),
            ...(end !== undefined && { endSeconds: end }),
            ...(fps !== undefined && { fps }),
          };
    const limitSeconds = Math.round(gemini.maxWaitMs / 1000);

    try {
      const outcome = await gemini.watch(
        { url, prompt, processing },
        ctx.mcpReq.signal,
        ({ elapsedMs, partsLoaded }) =>
          reportProgress(
            ctx,
            Math.floor(elapsedMs / 1000),
            limitSeconds,
            partsLoaded > 0
              ? `Watching: ${partsLoaded} part${partsLoaded === 1 ? '' : 's'} of the video looked at`
              : 'Watching the video',
          ),
      );

      switch (outcome.status) {
        case 'completed': {
          if (!outcome.text) {
            return toolError('Gemini finished without an answer. Ask again, more specifically.');
          }
          logger.info('Watched a video', {
            videoId,
            mode: chosen,
            model: gemini.model,
            totalTokens: outcome.usage.totalTokens,
          });
          return {
            content: [{ type: 'text', text: outcome.text }],
            structuredContent: {
              videoId,
              url,
              mode: chosen,
              model: gemini.model,
              answer: outcome.text,
              usage: outcome.usage,
            },
          };
        }
        case 'failed':
          logger.warning('Gemini could not watch the video', {
            videoId,
            interactionId: outcome.interactionId,
            code: outcome.code,
            detail: outcome.message,
          });
          return toolError(
            `Gemini could not watch ${url}. Check the video ID: the video must exist and be ` +
              'public. Private, unlisted, age-restricted and members-only videos cannot be watched.',
          );
        case 'incomplete':
          return toolError(
            'Gemini reached its output limit before it finished. Ask a narrower question, or ' +
              'for a shorter answer.',
          );
        case 'cancelled':
          return toolError('Gemini cancelled the request on its side. Try again.');
        case 'timeout':
          logger.warning('Gemini did not finish in time', {
            videoId,
            interactionId: outcome.interactionId,
            waitedMs: outcome.waitedMs,
          });
          return toolError(
            `Gemini did not finish within ${Math.round(limitSeconds / 60)} minutes, so the ` +
              'request was cancelled. Ask a narrower question, or watch a shorter section with ' +
              'mode "static" and start and end.',
          );
      }
    } catch (error) {
      if (ctx.mcpReq.signal.aborted) {
        // Not a failure. The service has already cancelled the interaction on Gemini.
        logger.info('The client cancelled a watch', { videoId });
        throw error;
      }
      if (error instanceof GeminiRejectedError) return rejected(error, gemini.model, logger);
      if (error instanceof UpstreamError) {
        logger.warning('Gemini is unavailable', { error });
        return toolError('Gemini is unavailable right now. Try again in a minute.');
      }
      throw error;
    }
  },
);

/** What the model is told when Gemini refuses the request, and what the operator sees. */
function rejected(error: GeminiRejectedError, model: string, logger: Logger) {
  const fields = {
    status: error.status,
    code: error.code,
    reason: error.reason,
    detail: error.detail,
  };
  if (error.isKeyProblem) {
    logger.error('Gemini refused the API key; check GEMINI_API_KEY', fields);
    return toolError(
      'This server cannot reach Gemini: its API key was refused. Tell the operator.',
    );
  }
  if (error.status === 429) {
    logger.warning('Gemini quota or rate limit reached', fields);
    return toolError(
      "The server's Gemini quota or rate limit is used up. Try again later. (Free-tier keys " +
        'can watch 8 hours of YouTube a day.)',
    );
  }
  if (error.status === 404) {
    logger.error(`Gemini does not know the model ${model}; check GEMINI_MODEL`, fields);
    return toolError(
      `This server is configured with a Gemini model that does not exist. Tell the operator.`,
    );
  }
  logger.warning('Gemini rejected the request', fields);
  return toolError(
    `Gemini rejected the request${error.detail ? `: ${error.detail.slice(0, 300)}` : '.'}`,
  );
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/**
 * The video ID in a YouTube URL (watch, youtu.be, shorts, live, embed) or a bare ID, or
 * `undefined` when `input` is neither. Only YouTube URLs reach Gemini, so a caller can't make
 * it fetch anything else.
 */
export function parseYouTubeVideo(input: string): string | undefined {
  const trimmed = input.trim();
  if (VIDEO_ID.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname.toLowerCase();
  const [first = '', second = ''] = url.pathname.split('/').filter(Boolean);

  let id: string | null | undefined;
  if (host === 'youtu.be' || host === 'www.youtu.be') id = first;
  else if (YOUTUBE_HOSTS.has(host)) {
    id =
      first === 'watch'
        ? url.searchParams.get('v')
        : ['shorts', 'live', 'embed', 'v'].includes(first)
          ? second
          : undefined;
  }
  return id && VIDEO_ID.test(id) ? id : undefined;
}
