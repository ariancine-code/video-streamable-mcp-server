# Changelog

## 1.0.0 — 2026-10-18

The first release: a remote MCP server that watches YouTube videos with Gemini. It is built on the remote MCP server template 2.1.0 (`af44256`) and `@modelcontextprotocol/server` 2.3.0, and it succeeds the local stdio server [`video-stdio-mcp`](https://github.com/iceener/video-stdio-mcp) for YouTube videos.

### Added

- **`watch_video`**: watches a public YouTube video and answers a question about it. It takes a URL in any common form or a bare video ID, and returns the answer with the canonical URL, the mode, the model and the token usage.
- **Agentic video understanding** as the default mode: Gemini reads the transcript and loads only the parts of the video it needs. **Static mode** watches frames at a fixed rate and can clip the video (`start`, `end`) and change the frame rate (`fps`).
- **Background interactions**: the server starts the watch on Gemini, polls it, reports progress between polls, and cancels it when the client cancels, a poll fails, or 10 minutes pass.
- **Bearer authentication** in production (`AUTH_MODE=bearer`), because every call spends Gemini tokens.

### Compared with `video-stdio-mcp`

- **Remote**: runs on Cloudflare Workers and Bun over Streamable HTTP, not as a local process over stdio.
- **The Interactions API** (`/v1beta/interactions`) replaces `generateContent`, and the API key moves from the URL's `key` parameter to the `x-goog-api-key` header.
- **`gemini-3.8-flash`** replaces `gemini-3-flash-preview` as the default model.
- **No local files**: a remote server has no files of yours to read. `VIDEO_PATHS` and the Files API upload are gone.
- **Tool and input names**: `video_understand` with `source`, `startOffset`, `endOffset` becomes `watch_video` with `video`, `start`, `end`, plus `mode`.
