import { expect, test } from 'bun:test';
import { parseConfig } from '../src/platform/config';
import { BEARER_TOKEN, HOST, PRODUCTION_ENV } from './production';
import {
  DEVELOPMENT,
  describePrivate,
  digestOf,
  EXAMPLE,
  PRIVATE,
  servedAs,
  shapeOf,
  type WranglerConfig,
} from './production-config';
import { TEST_SETTINGS } from './settings';

/**
 * The production config. The committed example, with stand-in values, is checked here and
 * served by the other tests. The real file is gitignored and is checked where it exists.
 */
test('the production Worker: name, workers.dev, both secrets, and no storage', () => {
  expect(EXAMPLE.name).toBe('video-mcp');
  expect(EXAMPLE.workers_dev).toBe(true);
  expect(EXAMPLE.secrets).toEqual({ required: ['GEMINI_API_KEY', 'BEARER_TOKEN'] });
  expect(EXAMPLE.kv_namespaces).toBeUndefined();
  expect(EXAMPLE.durable_objects).toBeUndefined();
  expect(EXAMPLE.migrations).toBeUndefined();
});

test('production runs the same code and runtime as development', () => {
  expect(shapeOf(EXAMPLE).runtime).toEqual(shapeOf(DEVELOPMENT).runtime);
});

test('the production vars, with both secrets, configure the server behind a bearer token', () => {
  const config = parseConfig(PRODUCTION_ENV);
  expect(config.environment).toBe('production');
  expect(config.auth).toEqual({ mode: 'bearer', token: BEARER_TOKEN });
  expect(config.publicUrl.href).toBe(`https://${HOST}/mcp`);
  expect(config.allowedHosts).toEqual([HOST]);
  expect(config.allowedOrigins).toEqual([
    HOST,
    'claude.ai',
    'claude.com',
    'alice.example.org',
    'ai.example.net',
    'agi.example.net',
    'example.org',
  ]);
  expect(config.legacy).toBe('stateless');
  expect(config.maxRequestBytes).toBe(1_048_576);
});

test('both secrets are trimmed, and Gemini is the real one', () => {
  // A secret stored with a trailing newline must still work.
  const config = parseConfig({
    ...PRODUCTION_ENV,
    BEARER_TOKEN: `${BEARER_TOKEN}\n`,
    GEMINI_API_KEY: 'AQ.key\n',
  });
  expect(config.auth).toEqual({ mode: 'bearer', token: BEARER_TOKEN });
  expect(config.settings).toEqual({
    GEMINI_API_KEY: 'AQ.key',
    GEMINI_MODEL: 'gemini-3.8-flash',
    GEMINI_API_URL: 'https://generativelanguage.googleapis.com/v1beta',
  });
});

test('production refuses to start without the Gemini key', () => {
  const { GEMINI_API_KEY: _, ...withoutKey } = PRODUCTION_ENV;
  expect(() => parseConfig(withoutKey)).toThrow('GEMINI_API_KEY is required');
});

describePrivate('wrangler.production.jsonc, the deployed configuration', () => {
  const real = PRIVATE as WranglerConfig;

  test("has the example's shape: the same keys, vars, list lengths, bindings and secrets", () => {
    expect(shapeOf(real)).toEqual(shapeOf(EXAMPLE));
  });

  test('serves what the example serves', () => {
    const secrets = { ...TEST_SETTINGS, BEARER_TOKEN };
    expect(servedAs(parseConfig({ ...real.vars, ...secrets }))).toEqual(
      servedAs(parseConfig({ ...EXAMPLE.vars, ...secrets })),
    );
  });

  test('is unchanged since the last deliberate production change', () => {
    // Any edit to wrangler.production.jsonc changes this digest. Update it in the same commit
    // as a deliberate production change; the values themselves stay out of the repository.
    expect(digestOf(real)).toBe('a81e49f0f9bea6c3c844e4329d0b30791ed31d28b0b816204d515ae5abd9ab3c');
  });
});
