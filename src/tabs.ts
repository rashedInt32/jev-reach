/**
 * Two small fixes to the stock navigation tools, applied in place.
 *
 *  1. `new_page` on a fresh browser loads into Chrome's blank start tab
 *     instead of leaving it idle and opening tab 2.
 *  2. `new_page` and `navigate_page` wait DEFAULT_NAV_TIMEOUT_MS when the
 *     caller sets no timeout, instead of the stock 10 s.
 *
 * The handlers are swapped in the SDK registry, the same private API the
 * reach warm-up uses, held steady by the exact chrome-devtools-mcp pin. The
 * tool names and input schemas stay stock, so callers see no difference.
 */

import type { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { blankTabToReuse, DEFAULT_NAV_TIMEOUT_MS } from "./lib.js";

type Content = Array<{ type: string; text?: string }>;
type Result = { content?: Content; isError?: boolean } & Record<string, unknown>;
type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<Result>;

const textOf = (result: Result): string =>
  (result.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");

const withDefaultTimeout = (args: Record<string, unknown>): Record<string, unknown> =>
  args.timeout === undefined ? { ...args, timeout: DEFAULT_NAV_TIMEOUT_MS } : args;

export function patchStockNavigation(server: SdkMcpServer): void {
  const registry = (server as unknown as { _registeredTools?: Record<string, { handler?: unknown }> })._registeredTools;
  const newPage = registry?.new_page;
  const navigate = registry?.navigate_page;
  const listPages = registry?.list_pages;
  if (typeof newPage?.handler !== "function" || typeof navigate?.handler !== "function" || typeof listPages?.handler !== "function") {
    console.error("[jev-reach] stock navigation tools not found; new_page and navigate_page run unpatched");
    return;
  }
  const stockNew = newPage.handler as Handler;
  const stockNavigate = navigate.handler as Handler;
  const stockList = listPages.handler as Handler;

  navigate.handler = ((args, extra) => stockNavigate(withDefaultTimeout(args), extra)) satisfies Handler;

  newPage.handler = (async (args, extra) => {
    const params = withDefaultTimeout(args);
    if (!params.isolatedContext && !params.background) {
      const listed = await stockList({}, extra);
      const reuse = listed.isError ? null : blankTabToReuse(textOf(listed), params);
      if (reuse !== null) {
        const result = await stockNavigate({ pageId: reuse, type: "url", url: params.url, timeout: params.timeout }, extra);
        if (result.isError) return result;
        const note = { type: "text", text: `Loaded in blank tab ${reuse} instead of opening a new tab. Use pageId ${reuse}.` };
        return { ...result, content: [note, ...(result.content ?? [])] };
      }
    }
    return stockNew(params, extra);
  }) satisfies Handler;
}
