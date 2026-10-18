import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serve } from '../src/bun';
import { createApp } from '../src/platform/app';
import { parseConfig } from '../src/platform/config';
import { createLogger } from '../src/platform/logger';
import { createDeps, type Deps } from '../src/server';
import { TEST_SETTINGS } from '../tests/settings';
import { abandonWatch } from './abandon-watch';
import { startGeminiMock } from './mock-gemini';
import { smoke } from './smoke-client';

/**
 * Bun drops a connection that stays quiet for 10 s by default. A watch can take minutes, and
 * a client that asks for no progress hears nothing until the answer, so this check holds a
 * call quiet for longer than Bun's window: it fails reliably without the fix in src/bun.ts.
 */
const QUIET_MS = 15_000;
const PUBLIC_URL = 'http://127.0.0.1/mcp';
const TOKEN = 'smoke-bearer-token';

/** Run the real Bun server on a free port, call `run` with its MCP URL, then stop it. */
async function withServer(
  env: Record<string, string>,
  run: (endpoint: URL) => Promise<void>,
  configure: (deps: Deps) => void = () => {},
): Promise<void> {
  const config = parseConfig({
    NODE_ENV: 'test',
    PORT: '0',
    MCP_PUBLIC_URL: PUBLIC_URL,
    MCP_MAX_REQUEST_BYTES: '1024',
    AUTH_MODE: 'bearer',
    BEARER_TOKEN: TOKEN,
    ...TEST_SETTINGS,
    ...env,
  });
  const deps = createDeps(config, createLogger('warning'), { waitUntil: () => {} });
  configure(deps);
  const app = createApp(config, { deps });
  const server = serve(config, app);
  try {
    await run(new URL('/mcp', server.url));
  } finally {
    await app.close();
    await server.stop(true);
  }
}

const gemini = await startGeminiMock(TEST_SETTINGS.GEMINI_API_KEY ?? '');
try {
  // Production auth mode, through the loopback Gemini mock, both protocol eras; then a client
  // that drops the connection mid-watch, which must cancel the interaction on Gemini.
  await withServer({ GEMINI_API_URL: gemini.url }, async (endpoint) => {
    await smoke(endpoint, 'bun', TOKEN);
    assert.ok(gemini.requests.length > 0, 'the tool reached the Gemini mock');
    await abandonWatch(endpoint, TOKEN);
    await gemini.cancelled(5_000);
    console.info('bun: a watch abandoned by its client was cancelled on Gemini');
  });

  // A slow watch: the call stays quiet past Bun's default idle timeout and still ends.
  await withServer(
    { GEMINI_API_URL: gemini.url },
    async (endpoint) => {
      const client = new Client(
        { name: 'smoke', version: '1.0.0' },
        { versionNegotiation: { mode: 'auto' } },
      );
      await client.connect(
        new StreamableHTTPClientTransport(endpoint, {
          fetch: (url, init) => {
            const headers = new Headers(init?.headers);
            headers.set('Authorization', `Bearer ${TOKEN}`);
            return fetch(url, { ...init, headers });
          },
        }),
      );
      const result = await client.callTool(
        { name: 'watch_video', arguments: { video: 'jNQXAC9IVRw', prompt: 'slow' } },
        { timeout: 20_000 },
      );
      await client.close();

      assert.equal(result.isError, undefined, JSON.stringify(result));
      console.info(`bun: a call quiet for ${QUIET_MS / 1000} s survived the idle timeout`);
    },
    (deps) => {
      const { gemini: real } = deps;
      deps.gemini = {
        ...real,
        watch: async (request, signal) => {
          await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
          signal.throwIfAborted();
          return real.watch(request, signal);
        },
      };
    },
  );
} finally {
  await gemini.close();
}
