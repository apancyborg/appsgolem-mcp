#!/usr/bin/env node
/**
 * AppsGolem MCP server (TypeScript/Node) — entry point.
 *
 * A thin bin wrapper: everything testable (the McpServer instance, its tools,
 * and the env→client boundary) lives in ./server-core.ts, which can be imported
 * without side effects. This file's ONLY job is to run main() over stdio, so the
 * published bin always starts the server when invoked.
 *
 *   APPSGOLEM_API_KEY   your API key (ag_live_…)   [required]
 *   APPSGOLEM_API_BASE  API base URL               [default https://appsgolem.com]
 *
 * Run over stdio (the transport Claude Desktop / most MCP clients use):
 *
 *   APPSGOLEM_API_KEY=ag_live_… npx appsgolem-mcp
 */
import { main } from "./server-core.js";

main().catch((e) => {
  process.stderr.write(String((e as Error)?.stack ?? e) + "\n");
  process.exit(1);
});
