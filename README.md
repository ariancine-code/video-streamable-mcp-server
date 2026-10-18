# Video MCP Server

A remote [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets agents watch YouTube videos. Give it a video and a question; Gemini watches the frames, listens to the audio, and answers.

It uses the [Gemini Interactions API](https://ai.google.dev/gemini-api/docs/video-understanding) and its **agentic video understanding**: the model reads the transcript first and loads only the parts of the video it needs, so a long video costs a fraction of the tokens of watching every frame.

The server runs on **Cloudflare Workers** and on **Bun**. It is built on the [remote MCP server template](https://github.com/iceener/streamable-mcp-server-template) 2.1 and the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) 2.3.0, and speaks protocol `2026-07-28` as well as the 2025 versions.

> [!NOTE]
> Answers come from a model. They can be incomplete or wrong, especially about small on-screen details. Each call spends Gemini tokens on the server's API key.

## The tool

### `watch_video`

Watches a public YouTube video and answers a question about it: summarize it, find a moment, read what is on screen, describe what happens, check what someone said.

| Input | Required | Description |
|---|---|---|
| `video` | yes | A `youtube.com` or `youtu.be` URL (watch, shorts, live, embed), or the 11-character video ID |
| `prompt` | yes | What to find out. Refer to moments as `MM:SS`: "What is on the slide at 12:30?" |
| `mode` | | `agentic` or `static`. See below |
| `start`, `end` | | Static mode: the section to watch, in seconds from the beginning |
| `fps` | | Static mode: frames per second to look at, 0.1–30 (default 1) |

| Mode | How Gemini watches | Best for |
|---|---|---|
| `agentic` (the default) | Reads the transcript, then looks only at the segments it needs | Long videos, specific questions, finding a moment |
| `static` | Frames at a fixed rate over the whole clip, plus the audio | Short clips, visual detail, frame-by-frame questions. Required for `start`, `end` and `fps`, and chosen automatically when you pass one of them |

The result is the answer as text, plus structured content:

```json
{
  "videoId": "DLzxrzFCyOs",
  "url": "https://www.youtube.com/watch?v=DLzxrzFCyOs",
  "mode": "agentic",
  "model": "gemini-3.8-flash",
  "answer": "This is the music video for Rick Astley's 1987 hit song \"Never Gonna Give You Up.\"",
  "usage": { "inputTokens": 92, "outputTokens": 97, "thoughtTokens": 2424, "toolUseTokens": 781, "totalTokens": 3394 }
}
```

A call takes from a few seconds to a few minutes. The server reports progress while Gemini works, so clients that reset their timeout on progress wait as long as needed. After 10 minutes the server cancels the call on Gemini's side and tells the model to ask a narrower question or watch a shorter section.

**Limits** (Gemini's): public videos only, not private, unlisted, age-restricted or members-only ones. Free-tier API keys can watch 8 hours of YouTube a day; paid keys have no daily limit.

The server has no prompts and no resources.

## Connect a client

The server URL is the deployed Worker's `MCP_PUBLIC_URL`, for example `https://video-mcp.<subdomain>.workers.dev/mcp`. Every request needs the header `Authorization: Bearer <BEARER_TOKEN>`.

| Client | Procedure |
|---|---|
| Claude Code | `claude mcp add --transport http video <server URL> --header "Authorization: Bearer <token>"` |
| MCP Inspector | `bun run inspector`. Choose **Streamable HTTP**, enter the server URL, and add the `Authorization` header |
| VS Code | Add `{ "servers": { "video": { "type": "http", "url": "<server URL>", "headers": { "Authorization": "Bearer <token>" } } } }` to `.vscode/mcp.json` |

Browser clients must also use an origin listed in `MCP_ALLOWED_ORIGIN_HOSTNAMES`.

## Configuration

The server's identity, instructions and dependencies are in `src/server.ts`. Its own settings are in `src/settings.ts`:

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | | Required. A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey). Sent to Gemini only, in the `x-goog-api-key` header. Store it as a secret |
| `GEMINI_MODEL` | `gemini-3.8-flash` | The model that watches. It must support agentic video processing: `gemini-4-argon`, `gemini-3.8-flash`, `gemini-3.6-flash` or `gemini-3.5-flash-lite` |
| `GEMINI_API_URL` | `https://generativelanguage.googleapis.com/v1beta` | Change it only to point tests at a local mock |

The other variables belong to the template: `MCP_PUBLIC_URL`, `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGIN_HOSTNAMES`, `MCP_LEGACY_MODE`, `MCP_MAX_REQUEST_BYTES`, `AUTH_MODE`, `BEARER_TOKEN`, `LOG_LEVEL`, `NODE_ENV`, `HOST` and `PORT`. `.env.example` describes each one.

If a setting is invalid, the server reports every problem at once: Bun refuses to start, and a Worker logs the problems and answers every request with a generic 500.

## Authentication

Production runs with `AUTH_MODE=bearer`: every client sends the same shared token, `BEARER_TOKEN`. Every call spends Gemini tokens, so the server must not be open to anyone who finds its URL. The token only gets callers in; the server never forwards it, and it calls Gemini with its own key.

To sign users in through an identity provider instead, use the template's `AUTH_MODE=oauth`; the [template's auth guide](https://github.com/iceener/streamable-mcp-server-template/blob/main/docs/auth.md) explains how.

## Deployment

See [docs/deploy.md](docs/deploy.md): the Worker, its two secrets, the first deploy and later ones.

## Development

Requirements: [Bun](https://bun.sh) 1.4 or later, and Node.js 22.18 or later.

```sh
bun install
cp .env.example .env     # then set GEMINI_API_KEY
bun run dev              # http://127.0.0.1:3000/mcp
```

To run on the Cloudflare runtime locally, put `GEMINI_API_KEY=…` in `.dev.vars` and run `bun run dev:worker` (`http://127.0.0.1:8787/mcp`).

| Script | What it does |
|---|---|
| `bun run check` | Type check, lint, tests, and a check that the generated Worker types are current |
| `bun run test:smoke` | Starts the real server on Bun and on workerd, with Gemini replaced by a loopback mock |
| `bun run deploy` | Deploys with `wrangler.production.jsonc` |
| `bun run types:worker` | Regenerates the Worker types after a change to `wrangler.jsonc` |

```
src/
  server.ts               Identity, instructions and dependencies
  settings.ts             GEMINI_API_KEY, GEMINI_MODEL, GEMINI_API_URL
  tools/watch-video.ts    The tool, and the YouTube URL parser
  services/gemini.ts      The Gemini Interactions API client
  platform/               Template code, identical in every server built on it
  bun.ts, worker.ts       Entry points
tests/                    The tool, the service, the platform and the production config
scripts/                  Smoke tests and the loopback Gemini mock
```

### How a watch works

The service starts a background interaction (`background: true`) and polls it every few seconds until it finishes. Each upstream request is short, so no connection has to stay open while Gemini works, and progress goes to the client between polls. If the client cancels, a poll fails, or the 10-minute limit passes, the service cancels the interaction so Gemini stops working on it. On Workers, the `enable_request_signal` compatibility flag and `waitUntil` make that work even when the client simply disconnects; [docs/deploy.md](docs/deploy.md#long-calls) explains.

Static clips send `start_offset` and `end_offset` as duration strings (`"90s"`). The API rejects plain numbers, although its documentation shows them; the loopback mock rejects them too, so the smoke tests catch a regression.

## License

[MIT](LICENSE)
