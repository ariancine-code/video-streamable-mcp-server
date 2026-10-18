/**
 * Start a `watch_video` call that the Gemini mock never finishes (prompt `hang`), then drop
 * the connection, the way a client cancels over HTTP. The server must then cancel the
 * interaction on Gemini. No imports, so both the Bun and the Node smoke scripts can load it.
 */
export async function abandonWatch(endpoint: URL, token: string, afterMs = 3_000): Promise<void> {
  const controller = new AbortController();
  const response = fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'watch_video',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'watch_video',
        arguments: { video: 'jNQXAC9IVRw', prompt: 'hang' },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
    signal: controller.signal,
  });
  // The body would only arrive after Gemini finished, which the mock never does.
  response.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, afterMs));
  controller.abort();
}
