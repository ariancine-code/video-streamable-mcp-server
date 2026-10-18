import { PRODUCTION_VARS } from './production-config';
import { TEST_SETTINGS } from './settings';

export { HOST } from './production-config';

/**
 * The stand-in production configuration for in-process tests: the vars of
 * wrangler.production.example.jsonc, plus stand-ins for its two secrets.
 */
export const BEARER_TOKEN = 'synthetic-caller-token';

export const PRODUCTION_ENV: Record<string, string> = {
  ...PRODUCTION_VARS,
  ...TEST_SETTINGS,
  BEARER_TOKEN,
};
