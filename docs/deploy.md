# Deploy

The facts about the production Worker, and how to deploy it. For Workers in general, see `docs/deploy.md` in the [template](https://github.com/iceener/streamable-mcp-server-template).

## The Worker

| Item | Value |
|---|---|
| Worker | `video-mcp` |
| Route | `workers.dev` only |
| MCP URL | `MCP_PUBLIC_URL` |
| Health check | `/health` on the same origin |
| Authentication | `AUTH_MODE=bearer` |
| Configuration | `wrangler.production.jsonc` (gitignored) |

## Production configuration

`wrangler.production.jsonc` is the production Wrangler config: the Worker name, the account and the variables. It is gitignored, because it names the deployed Worker. `wrangler.production.example.jsonc` has the same shape with stand-in values; to deploy your own copy, copy it to `wrangler.production.jsonc` and put in your values. `bun run deploy` runs `wrangler deploy --config wrangler.production.jsonc`. `wrangler.jsonc` is for `wrangler dev` only.

Where the real file exists, `tests/production.test.ts` checks it: it must have the example's shape, serve what the example serves, and match a pinned SHA-256 digest. A deliberate change to the file needs the new digest in that test, in the same commit. Without the file, those tests are skipped, and the workerd smoke run starts the example.

## Secrets

| Secret | What it is |
|---|---|
| `GEMINI_API_KEY` | The Gemini API key the server watches videos with |
| `BEARER_TOKEN` | The shared token every client sends as `Authorization: Bearer <token>`. Generate one with `openssl rand -hex 32` |

`wrangler.production.jsonc` declares both as required secrets, so a deploy fails if the Worker lacks either. The Worker has no other secrets, no KV namespaces and no Durable Objects.

To replace one:

```sh
bunx wrangler secret put GEMINI_API_KEY --config wrangler.production.jsonc
bunx wrangler secret put BEARER_TOKEN --config wrangler.production.jsonc
```

After you replace `BEARER_TOKEN`, update every client that sends it.

## Deploy the Worker

1. Make sure the checks pass:

   ```sh
   bun run check && bun run test:smoke
   ```

2. Do a dry run, and check the variables against [Variables](#variables):

   ```sh
   CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false bunx wrangler deploy --dry-run --config wrangler.production.jsonc --outdir /tmp/video-mcp-dryrun
   ```

3. Deploy:

   ```sh
   bun run deploy
   ```

   The first deploy of a new Worker has no secrets yet. Upload them with it: put both in a file only you can read (`chmod 600`), as `NAME=value` lines, run `bun run deploy --secrets-file <file>`, then delete the file.

4. Check that `/health` answers `{"status":"ok","name":"video-mcp","version":"…"}`.
5. Connect a client with the token, and call `watch_video`.

`bun run deploy` replaces all the Worker's variables with those in `wrangler.production.jsonc`. It keeps the secrets.

## Variables

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` |
| `MCP_PUBLIC_URL` | `https://video-mcp.<subdomain>.workers.dev/mcp` |
| `MCP_ALLOWED_HOSTS` | `video-mcp.<subdomain>.workers.dev` |
| `MCP_ALLOWED_ORIGIN_HOSTNAMES` | The Worker's host, `claude.ai`, `claude.com`, and the hosts of your own browser clients |
| `MCP_LEGACY_MODE` | `stateless` |
| `MCP_MAX_REQUEST_BYTES` | `1048576` |
| `AUTH_MODE` | `bearer` |
| `LOG_LEVEL` | `info` |

`GEMINI_MODEL` is unset, so the server uses `gemini-3.8-flash`. To change the model, add `GEMINI_MODEL` to `vars`.

## Long calls

A watch polls Gemini every 2 seconds at first, then every 5 seconds, for at most 10 minutes: about 120 requests to Gemini in the longest call. That fits the Workers Paid plan. The Free plan allows 50 subrequests per request, which ends a call after about 4 minutes.

A client cancels a call over HTTP by dropping the connection. The compatibility flag `enable_request_signal` makes that abort the request's signal; the server then cancels the interaction on Gemini, and `waitUntil` lets that last request finish after the client is gone. Without the flag, the Worker stops polling but Gemini runs the abandoned watch to the end, and bills it.

Wrangler's local dev server does not pass client disconnects on to the Worker, so the workerd smoke run cannot check this; `smoke-bun.ts` checks the same code path on Bun. To check the deployed Worker, run `bunx wrangler tail video-mcp --format pretty`, start a `watch_video` call on a long video, and cancel it in the client: the log shows `The client cancelled a watch`.

## Logs

Workers Logs receives JSON lines. The ones that matter:

| Message | Meaning |
|---|---|
| `Watched a video` | A call succeeded. `totalTokens` is what it cost |
| `Gemini could not watch the video` | The video is private, missing or restricted. `code` and `detail` are Gemini's |
| `Gemini refused the API key; check GEMINI_API_KEY` | The key is wrong, revoked, or blocked for the Gemini API |
| `Gemini quota or rate limit reached` | Free-tier keys allow 8 hours of YouTube a day |
| `Gemini does not know the model …; check GEMINI_MODEL` | The configured model does not exist |
| `Gemini did not finish in time` | A watch passed 10 minutes and was cancelled |
| `The client cancelled a watch` | The client gave up or disconnected; the interaction was cancelled on Gemini |
| `Gemini is unavailable` | Gemini answered 5xx, did not answer in 30 seconds, or the connection failed |
| `Unexpected tool failure` | A bug. The client received the `reference` value; search for it |
