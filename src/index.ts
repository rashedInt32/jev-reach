#!/usr/bin/env node
/**
 * jev-reach: chrome-devtools-mcp plus the `reach` tool, in one process.
 *
 * The stock server is built through its public factory and the extra tool is
 * registered on the SDK server it exposes. Same Chrome, same pipe, same page
 * objects, so the walk is recorded by the stock console and network collectors
 * and every stock flag keeps working.
 */

process.title = "jev-reach";

import { readFileSync } from "node:fs";
import process from "node:process";

const [major, minor] = process.version.substring(1).split(".").map(Number) as [number, number];
if (major < 20 || (major === 20 && minor < 19) || (major === 22 && minor < 12)) {
  console.error(`ERROR: jev-reach needs Node 20.19+, 22.12+, or newer. Found ${process.version}.`);
  process.exit(1);
}

const OUR_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    // fall through
  }
  return "0.0.0";
})();

/** The exact chrome-devtools-mcp release whose internals this build was verified against. */
const PINNED_DEVTOOLS = "1.9.0";

// ── Boot check: the deep imports this build relies on must still resolve ───

const DEEP_IMPORTS = [
  "chrome-devtools-mcp/build/src/utils/polyfill.js",
  "chrome-devtools-mcp/build/src/index.js",
  "chrome-devtools-mcp/build/src/config/mcp-options.js",
  "chrome-devtools-mcp/build/src/browser.js",
  "chrome-devtools-mcp/build/src/third_party/index.js",
  "chrome-devtools-mcp/build/src/version.js",
] as const;

for (const spec of DEEP_IMPORTS) {
  try {
    await import(spec);
  } catch (error) {
    console.error(`ERROR: jev-reach cannot load ${spec}: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`jev-reach ${OUR_VERSION} is built against chrome-devtools-mcp ${PINNED_DEVTOOLS} exactly. Reinstall jev-reach, or check that nothing overrode that dependency.`);
    process.exit(1);
  }
}

const { VERSION: DEVTOOLS_VERSION } = await import("chrome-devtools-mcp/build/src/version.js");
if (DEVTOOLS_VERSION !== PINNED_DEVTOOLS) {
  console.error(`ERROR: jev-reach ${OUR_VERSION} is verified against chrome-devtools-mcp ${PINNED_DEVTOOLS}; found ${DEVTOOLS_VERSION}. Reinstall jev-reach so the pinned version is used.`);
  process.exit(1);
}

const { McpServer, logDisclaimers } = await import("chrome-devtools-mcp/build/src/index.js");
const { parseArguments } = await import("chrome-devtools-mcp/build/src/config/mcp-options.js");
const { closeBrowser } = await import("chrome-devtools-mcp/build/src/browser.js");
const { StdioServerTransport } = await import("chrome-devtools-mcp/build/src/third_party/index.js");
const { registerReach } = await import("./reach.js");
const { patchStockNavigation } = await import("./tabs.js");

// ── Wire-up, mirroring the stock entrypoint ─────────────────────────────────

const args = parseArguments(`${OUR_VERSION} (chrome-devtools-mcp ${DEVTOOLS_VERSION})`);

if (process.env.CHROME_DEVTOOLS_MCP_CRASH_ON_UNCAUGHT !== "true") {
  process.on("unhandledRejection", (reason) => {
    console.error("[jev-reach] unhandled promise rejection", reason);
  });
}

let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[jev-reach] shutting down (${reason})`);
  setTimeout(() => process.exit(0), 5_000).unref();
  await closeBrowser().catch(() => {});
  process.exit(0);
}
process.stdin.on("end", () => void shutdown("stdin end"));
process.stdin.on("close", () => void shutdown("stdin close"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGHUP", () => void shutdown("SIGHUP"));

const server = await McpServer.from(args, {});
registerReach(server.server, args);
patchStockNavigation(server.server);
await server.connect(new StdioServerTransport());
console.error(`[jev-reach] ${OUR_VERSION} ready on chrome-devtools-mcp ${DEVTOOLS_VERSION}; tool 'reach' added`);
logDisclaimers(args);
