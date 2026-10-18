import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { TEST_SETTINGS } from '../tests/settings';

const VIDEO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

/**
 * Drive a running server over real sockets with the official client, in both protocol
 * eras, with `AUTH_MODE=bearer` and `token` as the shared secret. Shared by the Bun and
 * Workers smoke tests. `watch_video` calls the loopback Gemini mock (scripts/mock-gemini.ts),
 * so no traffic leaves the machine.
 */
export async function smoke(endpoint: URL, label: string, token: string): Promise<void> {
  assert.equal(endpoint.hostname, '127.0.0.1', 'smoke traffic stays on loopback');

  const health = await fetch(new URL('/health', endpoint));
  assert.equal(health.status, 200);

  // No token, a wrong one, and the Gemini key itself: none of them gets through.
  for (const authorization of [
    undefined,
    'Bearer wrong',
    `Bearer ${TEST_SETTINGS.GEMINI_API_KEY}`,
  ]) {
    const refused = await fetch(endpoint, {
      method: 'POST',
      headers: authorization ? { Authorization: authorization } : {},
    });
    assert.equal(refused.status, 401);
    const challenge = refused.headers.get('WWW-Authenticate') ?? '';
    assert.match(challenge, /^Bearer /);
    assert.doesNotMatch(challenge, /resource_metadata=/, 'bearer mode publishes no OAuth');
  }

  for (const era of ['modern', 'legacy'] as const) {
    const client = new Client(
      { name: 'smoke', version: '1.0.0' },
      { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        fetch: async (url, init) => {
          const headers = new Headers(init?.headers);
          headers.set('Authorization', `Bearer ${token}`);
          const response = await fetch(url, { ...init, headers, redirect: 'error' });
          assert.equal(response.headers.has('Mcp-Session-Id'), false, 'the server is stateless');
          return response;
        },
      }),
    );
    try {
      assert.equal(client.getProtocolEra(), era);
      assert.equal(client.getServerVersion()?.name, 'video-mcp');
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ['watch_video'],
      );

      const agentic = await client.callTool({
        name: 'watch_video',
        arguments: { video: 'https://youtu.be/jNQXAC9IVRw', prompt: 'What happens?' },
      });
      const clip = await client.callTool({
        name: 'watch_video',
        arguments: { video: 'jNQXAC9IVRw', prompt: 'What happens?', start: 2, end: 15, fps: 1 },
      });
      for (const result of [agentic, clip]) {
        assert.equal(result.isError, undefined, JSON.stringify(result));
        assert.ok(!JSON.stringify(result).includes(TEST_SETTINGS.GEMINI_API_KEY ?? ''), 'no key');
      }
      assert.deepEqual(agentic.structuredContent, {
        videoId: 'jNQXAC9IVRw',
        url: VIDEO_URL,
        mode: 'agentic',
        model: 'gemini-3.8-flash',
        answer: `Watched ${VIDEO_URL} ("agentic").`,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          thoughtTokens: 0,
          toolUseTokens: 0,
          totalTokens: 15,
        },
      });
      // The mock refuses numeric offsets, as Gemini does.
      assert.equal(
        (clip.structuredContent as { answer: string }).answer,
        `Watched ${VIDEO_URL} ({"type":"static","start_offset":"2s","end_offset":"15s","fps":1}).`,
      );
    } finally {
      await client.close();
    }
    console.info(`${label}: ${era} client watched a video through the Gemini mock`);
  }

  const foreignOrigin = await fetch(endpoint, {
    method: 'POST',
    headers: { Origin: 'https://evil.example', Authorization: `Bearer ${token}` },
  });
  assert.equal(foreignOrigin.status, 403);

  const oversized = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700));
        controller.enqueue(new Uint8Array(700));
        controller.close();
      },
    }),
  });
  assert.equal(oversized.status, 413);
  console.info(`${label}: bearer gate, Origin guard and streamed body limit passed`);
}

if (import.meta.main) {
  const [endpoint, label, token] = process.argv.slice(2);
  assert.ok(
    endpoint && label && token,
    'usage: bun scripts/smoke-client.ts <loopback MCP URL> <label> <bearer token>',
  );
  await smoke(new URL(endpoint), label, token);
}
