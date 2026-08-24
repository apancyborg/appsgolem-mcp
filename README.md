# appsgolem-mcp (Node / TypeScript)

[![npm](https://img.shields.io/npm/v/appsgolem-mcp)](https://www.npmjs.com/package/appsgolem-mcp)

An [MCP](https://modelcontextprotocol.io) server for the **AppsGolem** YouTube
cutter API. It lets an AI agent (Claude Desktop, Claude Code, Cursor, …) cut
clips from YouTube videos — in any format the web cutter supports — and get a
direct download URL back. The REST logic lives in a small, dependency-light
client (`src/client.ts`); `src/server.ts` is the thin MCP tool layer over it.

> **Get your API key → [appsgolem.com/agents](https://appsgolem.com/agents)** — sign up, add prepaid
> credits, and generate a key (`ag_live_…`). That page also has copy-paste
> setup for Claude Code, Codex, Cursor, and any MCP client, plus a prompt
> cookbook.

## Requirements

- Node.js >= 18 (uses the global `fetch`).
- An AppsGolem API key (`ag_live_…`) — get one at
  **[appsgolem.com/agents](https://appsgolem.com/agents)** (sign up → add credits → generate a key in
  your dashboard). Credits are prepaid; buy a pack or a subscription, no
  auto-renewal required.

## Install / connect (no manual install)

`npx` fetches and runs the server on demand — nothing to install globally.

**Claude Desktop / Cursor** — add to the client's MCP config (e.g.
`claude_desktop_config.json`):

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

**Claude Code** — one command:

```bash
claude mcp add appsgolem -e APPSGOLEM_API_KEY=ag_live_… -- npx -y appsgolem-mcp
```

The server speaks MCP over **stdio** (the transport those clients use). A
missing `APPSGOLEM_API_KEY` is not fatal at startup — the server still starts
and advertises its tools; each call then returns a clear `config_error` telling
you to set the key.

## Configuration

| Env var              | Required | Default                 | Notes                         |
| -------------------- | -------- | ----------------------- | ----------------------------- |
| `APPSGOLEM_API_KEY`  | yes      | —                       | Your `ag_live_…` key.         |
| `APPSGOLEM_API_BASE` | no       | `https://appsgolem.com` | Override for self-host / dev. |

## Pricing

1 produced clip = **1 credit**. **2160p (4K) = 4** credits per clip — *except*
`audio_only`, which stays **1**. A source **longer than 2 h** adds **+1** once
per job, but only when its duration is known (the surcharge is skipped if the
probe can't determine it). A batch/stitch of *N* clips costs *N* per-clip.
**Failed cuts are never billed.**

---

## Tools

The server exposes **three** tools. A call that passes MCP input-schema
validation returns a structured result — the API's own JSON on success, or
`{ "error": … }` on any handler/API failure — and never raises a protocol-level
error, so an agent always gets a usable object. (Invalid tool *arguments* are
rejected by the MCP SDK before the handler runs, as a text-only `isError`
result.)

### 1. `cut_youtube_video`

Cut a clip (or a batch of clips) from a YouTube video. By default it **waits**
until the clip is produced and returns its status (including a `download_url`
once a download token is ready); set `wait: false` to submit and return
immediately with the current job (its state is normally `queued` after dispatch).

**Parameters**

| Name              | Type      | Default  | Notes |
| ----------------- | --------- | -------- | ----- |
| `url`             | string    | —        | **Required.** YouTube watch / share / `youtu.be` URL. Playlists are rejected. |
| `start`           | string    | —        | Clip start: `"SS"`, `"MM:SS"`, or `"HH:MM:SS"` (≤ 300 h). Omit when using `clips`. |
| `end`             | string    | —        | Clip end, same formats (≤ 300 h). Omit when using `clips`. |
| `resolution`      | string    | `1080p`  | `144p` · `240p` · `360p` · `480p` · `720p` · `1080p` · `1440p` · `2160p` (4K; total cut ≤ 60 min). |
| `mode`            | string    | `video`  | `video` · `audio_only` · `both` · `nosound` · `short` · `gif` · `frames` (see **Modes** below). |
| `audio_format`    | string    | —        | The `audio_only` output format: `mp3` · `m4a` · `wav` · `flac` (server defaults to `mp3`). `both` always produces MP3. |
| `bitrate`         | string    | —        | Lossy-audio bitrate `320` · `256` · `192` · `128` (default `320`): MP3/M4A in `audio_only`, MP3 in `both`; ignored for WAV/FLAC. |
| `fast`            | boolean   | `false`  | Stream-copy (≈10× faster, keyframe-aligned); `video` / `nosound` / `both` only. Mutually exclusive with a non-1× `speed` — if both are set, `fast` wins and `speed` is forced to `1.0`. |
| `speed`           | number    | `1.0`    | Playback speed `0.5` · `1` · `1.25` · `1.5` · `2`. `video` / `nosound` / `both` / `audio_only`. |
| `interval_ms`     | integer   | `2000`   | `frames` sampling interval: `100` · `500` · `1000` · `2000` · `5000` · `10000` (non-sheet extraction is capped at 1,800 JPGs total across all clips). |
| `burn_ts`         | boolean   | `false`  | `frames`: burn the source timestamp onto each JPG. |
| `sheet`           | boolean   | `false`  | `frames`: return a single contact-sheet JPG (2–80 frames, single clip). Setting it disables `burn_ts`. |
| `clips`           | array     | —        | An array of **1–10** `{ start, end }` ranges **instead of** `start`/`end` (an empty array is rejected). |
| `stitch`          | boolean   | `false`  | With 2+ `clips`, join them into one file (else a zip of clips); ignored for a single clip. `video` / `audio_only` / `both` / `short` / `nosound`. |
| `idempotency_key` | string    | —        | A stable key (**≤ 200 chars**) so a retried request reuses the same job (sent as the `Idempotency-Key` header). |
| `wait`            | boolean   | `true`   | Poll until ready, up to the `timeout_seconds` polling deadline. |
| `timeout_seconds` | integer   | `300`    | Polling deadline in seconds (default 300). It bounds the *polling* only — the initial submission and one in-flight status request (each up to a 30 s request timeout) can extend total wall-clock. |

**Returns (`wait: true`, default)** — the produced job status. `download_url` is
present once a download token is available; if it isn't yet, poll again:

```json
{
  "id": "e48db1a2-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
  "state": "produced",
  "credits_reserved": 1,
  "created_at": "2026-08-22T12:00:00+00:00",
  "download_url": "https://appsgolem.com/v1/download/…/clip.mp4"
}
```

**Returns (`wait: false`)** — the job immediately, with its current state
(normally `queued` after dispatch) and no `download_url` yet; poll
`get_cut_status` with the `id` (or fetch `poll_url`):

```json
{
  "id": "e48db1a2-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
  "state": "queued",
  "credits_reserved": 1,
  "poll_url": "/v1/cuts/e48db1a2-1c3d-4e5f-8a9b-0c1d2e3f4a5b"
}
```

If the wait times out before the clip is ready, the result carries
`"still_processing": true` and the job `id` — poll `get_cut_status` with that
id. If the job reaches a terminal failure, the result is
`{ "error": "cut_failed", "state": "failed" | "refunded", "id": … }` (and no
credit is charged).

### 2. `get_cut_status`

Check a cut job by its id. Use it to poll a job started with
`cut_youtube_video(wait=false)` or one that timed out.

| Name     | Type   | Notes |
| -------- | ------ | ----- |
| `job_id` | string | **Required.** The job id (a UUID) returned by `cut_youtube_video`. |

**Returns** — the job's state; once produced/delivered it also carries a
`download_url` when a download token is available (otherwise poll again):

```json
{ "id": "e48db1a2-…", "state": "queued", "credits_reserved": 1, "created_at": "…" }
```

States progress `accepted → queued → produced → delivered`, or
`failed → refunded` on error.

### 3. `get_account_balance`

Return the API account's spendable credit balance and current hourly cap. No
parameters.

**Returns**

```json
{ "balance": 412, "hourly_cap": 60 }
```

---

## Modes

| `mode`       | Output | Notable options |
| ------------ | ------ | --------------- |
| `video`      | Video file, no watermark — normally MP4; `fast` preserves the source container (e.g. WebM at high res) | `resolution`, `fast`, `speed` |
| `audio_only` | mp3 / m4a / wav / flac | `audio_format`, `bitrate`, `speed` |
| `both`       | Video + MP3 together, as a zip (`fast` may preserve the video's source container) | `bitrate`, `fast`, `speed` |
| `nosound`    | Video with no audio track — normally MP4; `fast` preserves the source container | `resolution`, `fast`, `speed` |
| `short`      | Portrait 9:16 — AI smart-crop when applicable, else a letterbox-blur fallback whose exact aspect depends on the source (Shorts / Reels / TikTok) | `resolution` |
| `gif`        | Animated GIF (≤ 5 min; no multi-clip) | `resolution` |
| `frames`     | JPG stills | `interval_ms`, `burn_ts`, `sheet` |

---

## Example prompts

Because the agent picks the parameters from your request, you drive it in plain
language:

- *"Cut 0:30 to 1:15 from https://youtu.be/dQw4w9WgXcQ in 1080p."* →
  `cut_youtube_video(url, start="0:30", end="1:15")`
- *"Grab the audio of that video from 2:00 to 5:00 as an mp3."* →
  `mode="audio_only", audio_format="mp3"`
- *"Make a vertical short of the 10:00–10:45 highlight."* →
  `mode="short", start="10:00", end="10:45"`
- *"Turn 0:05–0:12 into a GIF."* → `mode="gif"`
- *"Extract a contact sheet of frames every 5 seconds from 1:00 to 2:00."* →
  `mode="frames", interval_ms=5000, sheet=true`
- *"Stitch 0:10–0:20 and 1:00–1:10 into one clip."* →
  `clips=[{start:"0:10",end:"0:20"},{start:"1:00",end:"1:10"}], stitch=true`
- *"Do a fast, stream-copy cut of 0:00–0:30."* → `fast=true`
- *"How many API credits do I have left?"* → `get_account_balance()`

---

## Result & error shapes

Every result from a handler is a plain object (MCP argument-validation
failures are the exception — see the Tools note above). On failure the object has an `error` code
(the tool call still succeeds):

| `error`          | When |
| ---------------- | ---- |
| `config_error`   | `APPSGOLEM_API_KEY` is missing. |
| `invalid_api_key`| The key was rejected (401). |
| `invalid_job_id` | `job_id` isn't a UUID. |
| `not_found`      | No such job for this account (404). |
| `cut_failed`     | The job reached `failed`/`refunded` (never billed). |
| `network_error`  | Connection/transport failure or request timeout. |
| `bad_request`    | The configured API base/path couldn't be built into a URL. |
| `http_error`     | A ≥400 response whose JSON body isn't an `{ error: … }` object (carries `status`). |
| `bad_response`   | A success response whose body isn't a JSON object (array/scalar/null), or — with `wait: true` — a cut submission that came back without a usable job `id`. |

API-level errors — validation `400`, `402 insufficient_credits`,
`404 not_found`, `409 idempotency_conflict` / `duplicate_in_flight`,
`429 rate_limited`, and `503 rate_limiter_unavailable` / `database_busy` — are
returned as the API's own error body plus a `status` field. A `429` also
includes `retry_after` (seconds, from `Retry-After`) plus a `reason`
(`submission_cap` · `request_rate` · `poll_rate`) so an agent can tell which
limit it hit and back off correctly. A `503` is usually transient (retry after
a short delay), but a persistent `503` is a server-side problem to report — not
to retry indefinitely.

**Status polling is not rate-limited for normal use** — checking a job's
progress never counts against your submissions/hour cap. You never need to
throttle `get_cut_status` yourself: `cut_youtube_video(wait=true)` polls and
paces for you (honoring the server's `poll_after` cadence and any `Retry-After`),
so a single tool call handles even long jobs.

Produced download links expire after a bounded window (~72 hours by default on
appsgolem.com; configurable per deployment) — fetch the file within it.

A relative `download_url` (the API returns a path) is resolved to a full URL
against the configured API base **only when the result stays on that origin**.
Any `download_url` that resolves **off** the API's origin — an absolute URL to
another host, or a relative path that escapes the origin — is **dropped** for
safety: the field is removed and the result carries `download_url_dropped: true`,
so you can tell it apart from a job that simply isn't produced yet. When
`cut_youtube_video` is waiting for you (`wait=true`, the default), an off-origin
link surfaces as a `download_url_unsafe` error instead of handing back a bad URL.

---

## Develop

```bash
npm install
npm run build      # tsc -> dist/
npm test           # builds, then runs node --test (no network)
npm start          # run the stdio server locally (key needed for calls, not startup)
```

## Publishing

`npm publish` (from this directory) makes `npx appsgolem-mcp` work for everyone.
The `prepare` script builds `dist/` automatically on install/publish.
