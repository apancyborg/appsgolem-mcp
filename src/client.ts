/**
 * Thin, testable HTTP client for the AppsGolem cutter API (/v1/).
 *
 * A faithful port of the Python `appsgolem_mcp.client.ApiClient`. Uses the
 * global `fetch` (Node >= 18) — no MCP dependency — so it can be unit-tested
 * with an injected fetch and imported without the MCP SDK.
 *
 * Every method resolves to a plain object the caller can hand straight to an
 * agent: the API's own JSON on success, or `{ error: <code>, ... }` on any
 * failure (HTTP error body, network error, or bad JSON). Nothing rejects for
 * an API-level error — an agent gets a structured result, not a stack trace.
 */

// Terminal job states (from account.api_models.ApiJob).
const READY_STATES = new Set(["produced", "delivered"]);
const DEAD_STATES = new Set(["failed", "refunded"]);

/** Raised only for a genuinely unusable client (e.g. no API key). API call
 *  failures are returned as objects, never thrown. */
export class ApiError extends Error {}

export type Dict = Record<string, unknown>;

export interface Clip {
  start?: string;
  end?: string;
}

export interface CutParams {
  url: string;
  // Optional fields accept null (not just undefined) so an MCP client that
  // serialises "unset" as null behaves like the Python Optional[...] schema;
  // createCut drops null and undefined identically.
  start?: string | null;
  end?: string | null;
  resolution?: string;
  mode?: string;
  audio_format?: string | null;
  bitrate?: string | null;
  fast?: boolean | null;
  speed?: number | null;
  interval_ms?: number | null;
  burn_ts?: boolean | null;
  sheet?: boolean | null;
  clips?: Clip[] | null;
  stitch?: boolean | null;
  idempotency_key?: string | null;
}

export interface ApiClientOptions {
  baseUrl?: string;
  /** Poll cadence for cutAndWait, in milliseconds (floored to > 0). */
  pollIntervalMs?: number;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable monotonic clock in ms (tests). */
  clock?: () => number;
}

function toInt(value: string | null | undefined): number | null {
  if (value == null) return null;
  // Match Python's int(): the WHOLE (trimmed) string must be an integer.
  // Reject "2.5", "2 seconds", etc. rather than partially parsing them.
  const t = value.trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number.parseInt(t, 10);
  return Number.isNaN(n) ? null : n;
}

/** Mirror Python's uuid.UUID() acceptance: strip urn:/uuid: prefixes, a
 *  wrapping {…}, and dashes, then require 32 hex digits. Returns the canonical
 *  dashed lowercase form, or null if it isn't a UUID. Blocks path-traversal /
 *  control-char job_ids before any request is built. */
function canonicalUuid(raw: string): string | null {
  let hex = String(raw ?? "").replace(/urn:/gi, "").replace(/uuid:/gi, "");
  hex = hex.replace(/^[{}]+|[{}]+$/g, "").replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  hex = hex.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isPlainObject(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class ApiClient {
  private readonly key: string;
  private readonly base: string;
  private readonly pollIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => number;

  constructor(apiKey: string, opts: ApiClientOptions = {}) {
    if (!apiKey) throw new ApiError("APPSGOLEM_API_KEY is required");
    this.key = apiKey;
    // Trailing slash so relative joins resolve correctly.
    this.base = (opts.baseUrl ?? "https://appsgolem.com").replace(/\/+$/, "") + "/";
    const pi = opts.pollIntervalMs;
    // Floor to a positive interval so a 0/negative value can't busy-spin.
    this.pollIntervalMs = pi && pi > 0 ? pi : 3000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.clock = opts.clock ?? (() => performance.now());
  }

  // -- low-level ------------------------------------------------------
  private url(path: string): string {
    return new URL(path.replace(/^\/+/, ""), this.base).href;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { Authorization: `Bearer ${this.key}`, ...(extra ?? {}) };
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<Dict> {
    let url: string;
    try {
      url = this.url(path);
    } catch (e) {
      // A malformed URL (e.g. a control char in an interpolated segment) —
      // return a dict rather than crashing the tool call.
      return { error: "bad_request", message: String((e as Error)?.message ?? e) };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let resp: Response;
    try {
      const init: RequestInit = {
        method,
        headers: this.headers(extraHeaders),
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
        (init.headers as Record<string, string>)["Content-Type"] = "application/json";
      }
      resp = await this.fetchImpl(url, init);
    } catch (e) {
      return { error: "network_error", message: String((e as Error)?.message ?? e) };
    } finally {
      clearTimeout(timer);
    }
    return this.parse(resp);
  }

  private async parse(resp: Response): Promise<Dict> {
    // Read the body as text ONCE (fetch bodies are single-use streams). A
    // failure here means the stream broke AFTER headers arrived — a transport
    // error, reported as network_error to match httpx (where such failures
    // raise at request time). A body that reads fine but isn't valid JSON
    // falls through to the checks below (http_error / bad_response).
    let raw: string;
    try {
      raw = await resp.text();
    } catch (e) {
      return { error: "network_error", message: String((e as Error)?.message ?? e) };
    }
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }

    if (resp.status >= 400) {
      if (isPlainObject(body) && "error" in body) {
        const out: Dict = { ...body, status: resp.status };
        // Surface Retry-After for 429 so an agent can back off.
        if (resp.status === 429 && resp.headers.has("Retry-After") && out.retry_after === undefined) {
          out.retry_after = toInt(resp.headers.get("Retry-After"));
        }
        return out;
      }
      return { error: "http_error", status: resp.status, message: raw.slice(0, 200) };
    }
    if (!isPlainObject(body)) {
      return { error: "bad_response", status: resp.status };
    }
    return this.absolutize(body);
  }

  /** Make a relative `download_url` (the API returns a path) into a full URL
   *  the agent/user can fetch directly. Already-absolute URLs (with a scheme)
   *  are left untouched; any relative reference is resolved against the base. */
  private absolutize(body: Dict): Dict {
    const dl = body.download_url;
    if (typeof dl === "string" && dl && !/^[a-z][a-z0-9+.\-]*:/i.test(dl)) {
      try {
        const resolved = new URL(dl, this.base);
        // Only rewrite when the relative ref stays on the API's OWN origin. A
        // protocol-relative or backslash-normalised ref (e.g. "\\evil/x" ->
        // //evil/x under WHATWG URL parsing) that jumps to another host is
        // left untouched, so a downstream auto-download can't be redirected
        // off-origin by a crafted API response.
        if (resolved.origin === new URL(this.base).origin) {
          return { ...body, download_url: resolved.href };
        }
      } catch {
        // Malformed relative ref — leave the original value untouched.
      }
    }
    return body;
  }

  // -- endpoints ------------------------------------------------------
  async createCut(p: CutParams): Promise<Dict> {
    const payload: Dict = {
      url: p.url,
      resolution: p.resolution ?? "1080p",
      mode: p.mode ?? "video",
    };
    // clips (a list of {start,end}) replaces the single start/end.
    if (p.clips != null) {
      payload.clips = p.clips;
    } else {
      payload.start = p.start ?? null;
      payload.end = p.end ?? null;
    }
    const optional: Array<[string, unknown]> = [
      ["audio_format", p.audio_format],
      ["bitrate", p.bitrate],
      ["fast", p.fast],
      ["speed", p.speed],
      ["interval_ms", p.interval_ms],
      ["burn_ts", p.burn_ts],
      ["sheet", p.sheet],
      ["stitch", p.stitch],
    ];
    for (const [k, v] of optional) {
      if (v !== undefined && v !== null) payload[k] = v;
    }
    const extra = p.idempotency_key ? { "Idempotency-Key": p.idempotency_key } : undefined;
    return this.request("POST", "/v1/cuts", payload, extra);
  }

  async getStatus(jobId: string): Promise<Dict> {
    // ApiJob ids are UUIDs and the route is <uuid:job_id>. Validate +
    // canonicalize before building the path so a crafted value can't
    // dot-segment out of /v1/cuts/ into another endpoint (e.g. "../account").
    const canonical = canonicalUuid(jobId);
    if (canonical === null) {
      return { error: "invalid_job_id", message: "job_id must be a UUID" };
    }
    return this.request("GET", `/v1/cuts/${canonical}`);
  }

  async getAccount(): Promise<Dict> {
    return this.request("GET", "/v1/account");
  }

  // -- high-level -----------------------------------------------------
  /** Submit a cut and poll until it's ready, failed, or `maxWaitSeconds`
   *  elapse. Returns the ready status (with `download_url`), an error object,
   *  or — on timeout — the last status plus a `still_processing` marker. */
  async cutAndWait(p: CutParams & { maxWaitSeconds?: number }): Promise<Dict> {
    // A NaN/Infinity maxWait would make the deadline comparison never true
    // (infinite loop); a negative one is meaningless. Coerce to a sane cap.
    let maxWaitMs = (p.maxWaitSeconds ?? 300) * 1000;
    if (!Number.isFinite(maxWaitMs)) maxWaitMs = 300000;
    maxWaitMs = Math.max(maxWaitMs, 0);

    const submit = await this.createCut(p);
    if ("error" in submit) return submit;
    const jobId = submit.id;
    if (!jobId || typeof jobId !== "string") {
      return { error: "bad_response", message: "no job id in response" };
    }

    const deadline = this.clock() + maxWaitMs;
    let last: Dict = submit;
    for (;;) {
      const status = await this.getStatus(jobId);
      if ("error" in status) return status;
      last = status;
      const state = status.state;
      if (typeof state === "string" && READY_STATES.has(state)) return status;
      if (typeof state === "string" && DEAD_STATES.has(state)) {
        return { error: "cut_failed", state, id: jobId };
      }
      const remaining = deadline - this.clock();
      if (remaining <= 0) {
        return {
          ...last,
          still_processing: true,
          message: "Cut is still processing; call get_cut_status with this id to check again.",
        };
      }
      // Never sleep past the deadline (so maxWait is a real cap even when
      // pollInterval is larger than the time left).
      await this.sleep(Math.min(this.pollIntervalMs, remaining));
    }
  }
}
