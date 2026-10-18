import * as z from 'zod/v4';

/**
 * Settings your own code needs: API keys, feature flags, upstream URLs. They are read from
 * the environment and validated at startup together with the platform's configuration, so
 * one misconfigured deploy reports every problem at once. Code reads them as
 * `deps.config.settings`.
 *
 * On Workers, store secrets with `wrangler secret put NAME --config wrangler.production.jsonc`, not in `vars`.
 */
export const Settings = z.object({
  GEMINI_API_KEY: z
    .string({ error: 'GEMINI_API_KEY is required: a Gemini API key from Google AI Studio' })
    .min(1)
    .describe('Gemini API key. It is sent to Gemini only, in the `x-goog-api-key` header.'),
  GEMINI_MODEL: z
    .string()
    .min(1)
    .default('gemini-3.8-flash')
    .describe(
      'The model that watches videos. It must support agentic video processing: ' +
        'gemini-4-argon, gemini-3.8-flash, gemini-3.6-flash or gemini-3.5-flash-lite.',
    ),
  GEMINI_API_URL: z
    .url({ protocol: /^https?$/ })
    .default('https://generativelanguage.googleapis.com/v1beta')
    .describe('Base URL of the Gemini API. Change it only to point tests at a local mock.'),
});

export type Settings = z.infer<typeof Settings>;
