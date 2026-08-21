// Unit tests for the ApiClient port — injected fetch, no network.
// Run with: npm test  (builds first, then `node --test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiClient, ApiError } from "../dist/client.js";

const KEY = "ag_live_test";

/** Build a client whose fetch is a scripted stub. `handler(url, init)` returns
 *  a Response (or throws to simulate a network error). Captures calls. */
function clientWith(handler, opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length - 1);
  };
  const c = new ApiClient(KEY, {
    baseUrl: "http://localhost:8000",
    fetchImpl,
    sleep: async () => {},
    clock: (() => {
      let t = 0;
      return () => (t += 1000); // advance 1s per read
    })(),
    ...opts,
  });
  return { c, calls };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

test("constructor requires an api key", () => {
  assert.throws(() => new ApiClient(""), ApiError);
});

test("createCut posts to /v1/cuts with Bearer auth and payload", async () => {
  const { c, calls } = clientWith(() => json({ id: "x", state: "queued" }, 202));
  const out = await c.createCut({ url: "https://youtu.be/abc", start: "0:00", end: "0:10" });
  assert.equal(out.state, "queued");
  assert.equal(calls[0].url, "http://localhost:8000/v1/cuts");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.url, "https://youtu.be/abc");
  assert.equal(body.resolution, "1080p"); // default
  assert.equal(body.mode, "video"); // default
  assert.equal(body.start, "0:00");
});

test("createCut with clips omits start/end and sends the array", async () => {
  const { c, calls } = clientWith(() => json({ id: "x" }, 202));
  await c.createCut({ url: "u", clips: [{ start: "0:00", end: "0:05" }], stitch: true });
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.clips, [{ start: "0:00", end: "0:05" }]);
  assert.equal(body.stitch, true);
  assert.ok(!("start" in body));
});

test("idempotency_key becomes a header, not a body field", async () => {
  const { c, calls } = clientWith(() => json({ id: "x" }, 202));
  await c.createCut({ url: "u", idempotency_key: "k1" });
  assert.equal(calls[0].init.headers["Idempotency-Key"], "k1");
  assert.ok(!("idempotency_key" in JSON.parse(calls[0].init.body)));
});

test("getStatus rejects a non-UUID without a request", async () => {
  const { c, calls } = clientWith(() => json({}));
  const out = await c.getStatus("../account");
  assert.equal(out.error, "invalid_job_id");
  assert.equal(calls.length, 0);
});

test("getStatus canonicalizes a valid UUID into the path", async () => {
  const { c, calls } = clientWith(() => json({ state: "queued" }));
  await c.getStatus("E48DEBA4-B26B-4631-AE11-7773A1A1B1A2");
  assert.equal(calls[0].url, "http://localhost:8000/v1/cuts/e48deba4-b26b-4631-ae11-7773a1a1b1a2");
});

test("429 surfaces retry_after from the header", async () => {
  const { c } = clientWith(() => json({ error: "rate_limited" }, 429, { "Retry-After": "2" }));
  const out = await c.getAccount();
  assert.equal(out.error, "rate_limited");
  assert.equal(out.status, 429);
  assert.equal(out.retry_after, 2);
});

test("an error body is passed through with the status code", async () => {
  const { c } = clientWith(() => json({ error: "insufficient_credits" }, 402));
  const out = await c.createCut({ url: "u" });
  assert.equal(out.error, "insufficient_credits");
  assert.equal(out.status, 402);
});

test("non-JSON error body -> http_error with a truncated message", async () => {
  const { c } = clientWith(() => new Response("<html>boom</html>", { status: 500 }));
  const out = await c.getAccount();
  assert.equal(out.error, "http_error");
  assert.equal(out.status, 500);
  assert.match(out.message, /boom/);
});

test("a thrown fetch becomes a network_error dict, not a rejection", async () => {
  const { c } = clientWith(() => {
    throw new TypeError("connection refused");
  });
  const out = await c.getAccount();
  assert.equal(out.error, "network_error");
  assert.match(out.message, /connection refused/);
});

test("a relative download_url is absolutized against the base", async () => {
  const { c } = clientWith(() => json({ state: "produced", download_url: "/v1/download/tok/clip.mp4" }));
  const out = await c.getStatus("e48deba4-b26b-4631-ae11-7773a1a1b1a2");
  assert.equal(out.download_url, "http://localhost:8000/v1/download/tok/clip.mp4");
});

test("an absolute download_url is left untouched", async () => {
  const abs = "https://cdn.example.com/clip.mp4";
  const { c } = clientWith(() => json({ state: "produced", download_url: abs }));
  const out = await c.getStatus("e48deba4-b26b-4631-ae11-7773a1a1b1a2");
  assert.equal(out.download_url, abs);
});

test("cutAndWait polls until produced, then returns the ready status", async () => {
  const states = ["queued", "queued", "produced"];
  let i = 0;
  const { c, calls } = clientWith((url, init) => {
    if (init.method === "POST") return json({ id: "e48deba4-b26b-4631-ae11-7773a1a1b1a2", state: "queued" }, 202);
    return json({ state: states[i++], download_url: "/v1/download/t/c.mp4" });
  });
  const out = await c.cutAndWait({ url: "u", maxWaitSeconds: 300 });
  assert.equal(out.state, "produced");
  assert.equal(out.download_url, "http://localhost:8000/v1/download/t/c.mp4");
  assert.equal(calls.filter((x) => x.init.method === "GET").length, 3);
});

test("cutAndWait returns cut_failed on a dead state", async () => {
  const { c } = clientWith((url, init) =>
    init.method === "POST"
      ? json({ id: "e48deba4-b26b-4631-ae11-7773a1a1b1a2", state: "queued" }, 202)
      : json({ state: "failed" }),
  );
  const out = await c.cutAndWait({ url: "u" });
  assert.equal(out.error, "cut_failed");
  assert.equal(out.state, "failed");
});

test("cutAndWait times out with still_processing (clock past deadline)", async () => {
  // clock advances 1000ms per read; maxWait 0 -> immediate timeout after submit.
  const { c } = clientWith((url, init) =>
    init.method === "POST"
      ? json({ id: "e48deba4-b26b-4631-ae11-7773a1a1b1a2", state: "queued" }, 202)
      : json({ state: "queued" }),
  );
  const out = await c.cutAndWait({ url: "u", maxWaitSeconds: 0 });
  assert.equal(out.still_processing, true);
  assert.match(out.message, /still processing/i);
});

// --- parity fixes (Codex PR#30 review) ---

test("createCut drops null optional fields (null == unset, like Python)", async () => {
  const { c, calls } = clientWith(() => json({ id: "x" }, 202));
  await c.createCut({ url: "u", fast: null, speed: null, clips: null, start: null, end: null });
  const body = JSON.parse(calls[0].init.body);
  assert.ok(!("fast" in body));
  assert.ok(!("speed" in body));
  assert.ok(!("clips" in body));
  // start/end are still present (null) when clips is absent — matches Python.
  assert.equal(body.start, null);
  assert.equal(body.end, null);
});

test("getStatus accepts 32-hex and braced UUID forms and canonicalizes", async () => {
  const { c, calls } = clientWith(() => json({ state: "queued" }));
  await c.getStatus("e48deba4b26b4631ae117773a1a1b1a2"); // 32 hex, no dashes
  await c.getStatus("{e48deba4-b26b-4631-ae11-7773a1a1b1a2}"); // braces
  const want = "http://localhost:8000/v1/cuts/e48deba4-b26b-4631-ae11-7773a1a1b1a2";
  assert.equal(calls[0].url, want);
  assert.equal(calls[1].url, want);
});

test("getStatus rejects a whitespace-padded UUID (matches Python)", async () => {
  const { c, calls } = clientWith(() => json({}));
  const out = await c.getStatus(" e48deba4-b26b-4631-ae11-7773a1a1b1a2 ");
  assert.equal(out.error, "invalid_job_id");
  assert.equal(calls.length, 0);
});

test("429 Retry-After with a non-integer value yields retry_after null", async () => {
  const { c } = clientWith(() => json({ error: "rate_limited" }, 429, { "Retry-After": "2.5" }));
  const out = await c.getAccount();
  assert.equal(out.retry_after, null);
});

test("a protocol-relative download_url is NOT rewritten off-origin", async () => {
  const { c } = clientWith(() => json({ state: "produced", download_url: "//evil.example/x" }));
  const out = await c.getStatus("e48deba4-b26b-4631-ae11-7773a1a1b1a2");
  assert.equal(out.download_url, "//evil.example/x"); // untouched, no host jump
});
