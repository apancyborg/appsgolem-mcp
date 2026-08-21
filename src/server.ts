#!/usr/bin/env node
/**
 * AppsGolem MCP server (TypeScript/Node) — exposes the cutter API as MCP tools.
 *
 * A thin wrapper over `ApiClient` (client.ts). Configure with two env vars:
 *
 *   APPSGOLEM_API_KEY   your API key (ag_live_…)   [required]
 *   APPSGOLEM_API_BASE  API base URL               [default https://appsgolem.com]
 *
 * Run over stdio (the transport Claude Desktop / most MCP clients use):
 *
 *   APPSGOLEM_API_KEY=ag_live_… npx appsgolem-mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ApiClient, ApiError, type CutParams, type Dict } from "./client.js";

function makeClient(): ApiClient {
  const key = process.env.APPSGOLEM_API_KEY;
  if (!key) {
    throw new ApiError(
      "APPSGOLEM_API_KEY is not set — create a key in the AppsGolem dashboard " +
        "and export it before starting the server.",
    );
  }
  const base = process.env.APPSGOLEM_API_BASE ?? "https://appsgolem.com";
  return new ApiClient(key, { baseUrl: base });
}

/** Wrap a result object as an MCP tool result: JSON text plus structured
 *  content so both text-only and structured-aware clients get the data. */
function result(obj: Dict) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
    structuredContent: obj,
  };
}

/** Turn an unexpected throw (e.g. missing API key) into a structured error
 *  result rather than a protocol-level error — matches the client's contract
 *  of always handing the agent a usable object. */
function errorResult(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: "config_error", message }, null, 2) }],
    structuredContent: { error: "config_error", message } as Dict,
    isError: true,
  };
}

const server = new McpServer({ name: "appsgolem", version: "0.1.0" });

const clipSchema = z.object({
  start: z.string().nullish(),
  end: z.string().nullish(),
});

server.registerTool(
  "cut_youtube_video",
  {
    title: "Cut a YouTube video",
    description:
      "Cut a clip (or clips) from a YouTube video and return a download URL. " +
      "Submits a cut job to AppsGolem and (by default) polls until it's produced, " +
      "then returns the download URL. Pricing: 1 credit per produced clip (4K = 4/clip; " +
      "source > 2h = +1 once); a batch/stitch of N clips costs N per-clip. Failed cuts " +
      "are never billed. On a wait-timeout the result has still_processing=true; poll " +
      "get_cut_status with the returned id.",
    inputSchema: {
      url: z
        .string()
        .describe("A YouTube video URL (watch/share/youtu.be — playlists rejected)."),
      start: z
        .string()
        .nullish()
        .describe('Clip start as "SS"/"MM:SS"/"HH:MM:SS". Omit when passing clips.'),
      end: z
        .string()
        .nullish()
        .describe('Clip end as "SS"/"MM:SS"/"HH:MM:SS". Omit when passing clips.'),
      resolution: z
        .string()
        .default("1080p")
        .describe("360p/480p/720p/1080p (default)/1440p/2160p (4K; total cut ≤60 min)."),
      mode: z
        .string()
        .default("video")
        .describe(
          'One of "video" (MP4, default), "audio_only" (mp3/m4a/wav/flac), "both" ' +
            '(MP4+MP3 zip), "nosound" (MP4, no audio), "short" (9:16 vertical, AI ' +
            'smart-crop), "gif" (animated GIF, ≤5 min), "frames" (JPG stills).',
        ),
      audio_format: z
        .string()
        .nullish()
        .describe('For audio_only — "mp3"(default)/"m4a"/"wav"/"flac".'),
      bitrate: z
        .string()
        .nullish()
        .describe('MP3 bitrate "320"(default)/"256"/"192"/"128" (audio_only/both).'),
      fast: z
        .boolean()
        .nullish()
        .describe("Stream-copy (≈10× faster, keyframe-aligned); video/nosound/both only."),
      speed: z
        .number()
        .nullish()
        .describe("Playback speed 0.5/1.0/1.25/1.5/2.0; video/nosound/both/audio_only."),
      interval_ms: z
        .number()
        .int()
        .nullish()
        .describe("Frames sampling interval — 100/500/1000/2000(default)/5000/10000."),
      burn_ts: z
        .boolean()
        .nullish()
        .describe("Frames — burn the source timestamp onto each JPG."),
      sheet: z
        .boolean()
        .nullish()
        .describe("Frames — a single contact-sheet JPG (2..80 frames, single clip)."),
      clips: z
        .array(clipSchema)
        .nullish()
        .describe("A list of {start,end} ranges (max 10) INSTEAD of start/end."),
      stitch: z
        .boolean()
        .nullish()
        .describe(
          "With clips, join them into one file (else a zip of clips); " +
            "video/audio_only/both/short/nosound only.",
        ),
      wait: z
        .boolean()
        .default(true)
        .describe("Block until ready (default) up to timeout_seconds."),
      timeout_seconds: z
        .number()
        .int()
        .default(300)
        .describe("Max seconds to wait when wait=true."),
      idempotency_key: z
        .string()
        .nullish()
        .describe("A stable key so a retried request reuses the same job."),
    },
  },
  async (args) => {
    try {
      const { wait, timeout_seconds, ...rest } = args;
      const cut = rest as CutParams;
      const client = makeClient();
      const out = wait
        ? await client.cutAndWait({ ...cut, maxWaitSeconds: timeout_seconds })
        : await client.createCut(cut);
      return result(out);
    } catch (e) {
      return errorResult(e);
    }
  },
);

server.registerTool(
  "get_cut_status",
  {
    title: "Check a cut job",
    description:
      "Check a cut job's status by its id. Returns the job's state (accepted / queued / " +
      "produced / delivered / failed / refunded) and, once produced, a download_url. Use " +
      "this to poll a job started with cut_youtube_video(wait=false) or one that timed out.",
    inputSchema: {
      job_id: z.string().describe("The job id (a UUID) returned by cut_youtube_video."),
    },
  },
  async ({ job_id }) => {
    try {
      const client = makeClient();
      return result(await client.getStatus(job_id));
    } catch (e) {
      return errorResult(e);
    }
  },
);

server.registerTool(
  "get_account_balance",
  {
    title: "Account balance",
    description: "Return the API account's spendable credit balance and hourly cap.",
    inputSchema: {},
  },
  async () => {
    try {
      const client = makeClient();
      return result(await client.getAccount());
    } catch (e) {
      return errorResult(e);
    }
  },
);

async function main(): Promise<void> {
  // A missing APPSGOLEM_API_KEY is deliberately NOT fatal at startup: the
  // server still starts and advertises its tools (so an MCP client can
  // discover them), and each tool call returns a clear config_error telling
  // the user to set the key. Mirrors the Python server's behaviour.
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(String((e as Error)?.stack ?? e) + "\n");
  process.exit(1);
});
