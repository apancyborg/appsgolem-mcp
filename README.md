# appsgolem-mcp (Node / TypeScript)

An [MCP](https://modelcontextprotocol.io) server for the **AppsGolem** YouTube
cutter API. Lets an AI agent (Claude Desktop, Claude Code, Cursor, …) cut clips
from YouTube videos and get a download URL. This is the TypeScript/Node port of
the Python [`appsgolem-mcp`](../mcp_server) package — identical tools and
behaviour.

## Requirements

- Node.js >= 18
- An AppsGolem API key (`ag_live_…`) — create one in your dashboard at
  `https://appsgolem.com/api-billing/`.

## Use it with an MCP client (no install)

`npx` fetches and runs it on demand. Add this to your client's MCP config (e.g.
Claude Desktop's `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "appsgolem": {
      "command": "npx",
      "args": ["-y", "appsgolem-mcp"],
      "env": { "APPSGOLEM_API_KEY": "ag_live_…" }
    }
  }
}
```

Or add it to Claude Code:

```bash
claude mcp add appsgolem -e APPSGOLEM_API_KEY=ag_live_… -- npx -y appsgolem-mcp
```

## Configuration

| Env var              | Required | Default                  | Notes                          |
| -------------------- | -------- | ------------------------ | ------------------------------ |
| `APPSGOLEM_API_KEY`  | yes      | —                        | Your `ag_live_…` key.          |
| `APPSGOLEM_API_BASE` | no       | `https://appsgolem.com`  | Override for self-host / dev.  |

## Tools

- **`cut_youtube_video`** — cut a clip (or a batch/stitch of up to 10 clips)
  and, by default, wait until it's produced and return a `download_url`.
  Supports every mode the web cutter has: `video`, `audio_only`, `both`,
  `nosound`, `short` (9:16), `gif`, `frames`, plus `fast`, `speed`,
  resolution/bitrate, and multi-clip `stitch`. Pricing: 1 credit per produced
  clip (4K = 4/clip; source > 2h = +1 once). Failed cuts are never billed.
- **`get_cut_status`** — poll a job by id; returns its state and, once
  produced, a `download_url`.
- **`get_account_balance`** — spendable credits and hourly cap.

Every tool returns a structured result — the API's JSON on success, or
`{ "error": … }` on failure — never a protocol error.

## Develop

```bash
npm install
npm run build      # tsc -> dist/
npm test           # builds, then runs node --test (no network)
npm start          # run the stdio server locally (needs APPSGOLEM_API_KEY)
```

## Publishing

`npm publish` (from this directory) makes `npx appsgolem-mcp` work for everyone.
The `prepare` script builds `dist/` automatically on install/publish.
