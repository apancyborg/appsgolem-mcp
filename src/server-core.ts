/**
 * AppsGolem MCP server core — the McpServer instance, its tools, and the
 * env→client boundary. Separated from the `server.ts` entry point so it can be
 * imported by tests WITHOUT starting a stdio transport (the entry file's only
 * job is to call main()). Mirrors the Python server's importable module.
 *
 * Configure with two env vars:
 *   APPSGOLEM_API_KEY   your API key (ag_live_…)   [required]
 *   APPSGOLEM_API_BASE  API base URL               [default https://appsgolem.com]
 */
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ApiClient, ApiError, type CutParams, type Dict } from "./client.js";

export function makeClient(): ApiClient {
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

// Single source of truth for the version: read package.json at runtime so the
// advertised serverInfo can never drift from the published package version.
// (npm always includes package.json in the tarball; ../ from dist/server-core.js.)
export const VERSION: string = (() => {
  try {
    const pkg = new URL("../package.json", import.meta.url);
    return JSON.parse(readFileSync(pkg, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
export const server = new McpServer({ name: "appsgolem", version: VERSION });

const clipSchema = z.object({
  start: z.string().nullish(),
  end: z.string().nullish(),
});

server.registerTool(
  "cut_youtube_video",
  {
    title: "Cut a YouTube video",
    description:
      "Cut a clip (or clips) from a YouTube video and return its download URL. " +
      "Submits a cut job to AppsGolem and (by default) polls until it's produced, then " +
      "returns the produced status — which includes a download_url once a download token " +
      "is ready. Pricing: 1 credit per produced clip (4K = 4/clip, except audio_only " +
      "which stays 1; a known source duration > 2h adds +1 once); a batch/stitch of N " +
      "clips costs N per-clip. Failed cuts are never billed. On a wait-timeout the result " +
      "has still_processing=true; poll get_cut_status with the returned id.",
    inputSchema: {
      url: z
        .string()
        .describe("A YouTube video URL (watch/share/youtu.be — playlists rejected)."),
      start: z
        .string()
        .nullish()
        .describe('Clip start as "SS"/"MM:SS"/"HH:MM:SS" (≤300h). Omit when passing clips.'),
      end: z
        .string()
        .nullish()
        .describe('Clip end as "SS"/"MM:SS"/"HH:MM:SS" (≤300h). Omit when passing clips.'),
      resolution: z
        .string()
        .default("1080p")
        .describe("144p/240p/360p/480p/720p/1080p (default)/1440p/2160p (4K; total cut ≤60 min)."),
      mode: z
        .string()
        .default("video")
        .describe(
          'One of "video" (video file, default; MP4 normally, source container e.g. ' +
            'WebM in fast mode), "audio_only" (mp3/m4a/wav/flac), "both" (video + MP3 ' +
            'zip), "nosound" (video, no audio), "short" (portrait 9:16; AI smart-crop ' +
            'when applicable, else letterbox-blur with source-dependent aspect), "gif" ' +
            '(animated GIF, ≤5 min), ' +
            '"frames" (JPG stills).',
        ),
      audio_format: z
        .string()
        .nullish()
        .describe('audio_only output format — "mp3"(default)/"m4a"/"wav"/"flac". both always produces MP3.'),
      bitrate: z
        .string()
        .nullish()
        .describe('Lossy-audio bitrate "320"(default)/"256"/"192"/"128" — MP3/M4A in audio_only, MP3 in both; ignored for wav/flac.'),
      fast: z
        .boolean()
        .nullish()
        .describe("Stream-copy (≈10× faster, keyframe-aligned); video/nosound/both only. Mutually exclusive with a non-1× speed — fast wins and speed is forced to 1.0."),
      speed: z
        .number()
        .nullish()
        .describe("Playback speed 0.5/1.0/1.25/1.5/2.0; video/nosound/both/audio_only."),
      interval_ms: z
        .number()
        .int()
        .nullish()
        .describe("Frames sampling interval — 100/500/1000/2000(default)/5000/10000; non-sheet extraction is capped at 1800 JPGs total across all clips."),
      burn_ts: z
        .boolean()
        .nullish()
        .describe("Frames — burn the source timestamp onto each JPG."),
      sheet: z
        .boolean()
        .nullish()
        .describe("Frames — a single contact-sheet JPG (2..80 frames, single clip); disables burn_ts."),
      clips: z
        .array(clipSchema)
        .nullish()
        .describe("A non-empty list of 1–10 {start,end} ranges INSTEAD of start/end."),
      stitch: z
        .boolean()
        .nullish()
        .describe(
          "With 2+ clips, join them into one file (else a zip of clips); ignored for a " +
            "single clip; video/audio_only/both/short/nosound only.",
        ),
      wait: z
        .boolean()
        .default(true)
        .describe("Poll until ready (default) up to the timeout_seconds polling deadline."),
      timeout_seconds: z
        .number()
        .int()
        .default(300)
        .describe("Polling deadline in seconds when wait=true (default 300); submission + one in-flight status request can extend total wall-clock."),
      idempotency_key: z
        .string()
        .nullish()
        .describe("A stable key (≤200 chars) so a retried request reuses the same job."),
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
      "produced / delivered / failed / refunded) and, once produced/delivered, a " +
      "download_url when a download token is available. Use this to poll a job started " +
      "with cut_youtube_video(wait=false) or one that timed out.",
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

export async function main(): Promise<void> {
  // A missing APPSGOLEM_API_KEY is deliberately NOT fatal at startup: the
  // server still starts and advertises its tools (so an MCP client can
  // discover them), and each tool call returns a clear config_error telling
  // the user to set the key. Mirrors the Python server's behaviour.
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
