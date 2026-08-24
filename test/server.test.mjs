// Server-layer tests: the env→client boundary + tool registration, mirroring
// the Python server's tests/test_server.py. Run with: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server, makeClient, VERSION } from "../dist/server-core.js";
import { ApiError } from "../dist/client.js";

// The real published version, read the same way server-core does (../ from
// dist/). Comparing against it proves VERSION loaded, not the "0.0.0" fallback.
const PKG_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

/** Swap env for one test and always restore (tests run sequentially per file). */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("VERSION is the real package.json version (not the 0.0.0 fallback)", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
  assert.equal(VERSION, PKG_VERSION);
});

test("advertises exactly its three tools + serverInfo over the protocol", async () => {
  // Real protocol surface via an in-memory transport — SDK-version-independent
  // (no reliance on private registries); a dropped registerTool fails this.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-harness", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["cut_youtube_video", "get_account_balance", "get_cut_status"],
    );
    const info = client.getServerVersion();
    assert.equal(info?.name, "appsgolem");
    assert.equal(info?.version, VERSION);
  } finally {
    await client.close();
    await server.close();
  }
});

test("makeClient requires APPSGOLEM_API_KEY", () => {
  withEnv({ APPSGOLEM_API_KEY: undefined }, () => {
    assert.throws(() => makeClient(), ApiError);
  });
});

test("makeClient uses the env key and defaults to appsgolem.com", () => {
  withEnv({ APPSGOLEM_API_KEY: "ag_live_x", APPSGOLEM_API_BASE: undefined }, () => {
    const c = makeClient();
    // `base` is TS-private but readable at runtime from this .mjs test — the
    // same inspection the Python server test does on `_base`. Exact match so a
    // look-alike host (e.g. appsgolem.com.evil/) can't slip past a prefix check;
    // the client normalizes to a single trailing slash.
    assert.equal(c.base, "https://appsgolem.com/");
  });
});

test("makeClient honors APPSGOLEM_API_BASE override", () => {
  withEnv(
    { APPSGOLEM_API_KEY: "ag_live_x", APPSGOLEM_API_BASE: "https://staging.example" },
    () => {
      const c = makeClient();
      assert.equal(c.base, "https://staging.example/");
    },
  );
});
