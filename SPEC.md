# jev-reach — spec

jev-reach is chrome-devtools-mcp with one extra tool, `reach`. Jev walks the
browser to the spot where a bug can be verified. Claude then makes one devtools
call there instead of one call per click.

## Shape

- A bin that builds the stock chrome-devtools-mcp server through its public
  `McpServer.from()` factory, registers `reach` on the exposed SDK server, and
  starts stdio. Same process, same Chrome over the same pipe, same puppeteer
  pages. No port, no proxy, no fork.
- MCP config swaps `chrome-devtools-mcp@latest` for `jev-reach`. Every flag
  chrome-devtools-mcp accepts still works. `--isolated` per session keeps one
  Chrome per agent.
- chrome-devtools-mcp is pinned to exactly 1.9.0. Boot verifies the deep imports
  and the installed version and fails with a clear message if they moved. Bumps
  are manual, after a smoke run.

## The reach tool

Inputs: `goal`, optional `url`, optional `tab_url_prefix`, optional `values`
map, `max_steps` (15), `allow_irreversible` (false), `settle_ms` (500),
`timeout_ms` (60000).

Per call:

1. Warm the stock server by dispatching an internal `list_pages`. That launches
   Chrome if needed and attaches the console and network collectors, so the
   walk is recorded. The reply names the selected page; reach acts on it.
2. Navigate to `url` when given.
3. Each step: snapshot visible, enabled interactive elements in the main frame
   and open shadow roots, number them, rank in-viewport first. Above 254, split
   into chunks, shortlist in parallel, then a final pick.
4. One parallel Jev call: element, action, value binding (when values exist),
   goal reached, irreversible, login wall, blocked.
5. Act through puppeteer on the same page objects. Settle on network quiet.
6. Diff URL, text, and inputs. Done at 0.85 or above. Likely done from 0.6.
   Three no-diff steps means stuck.

Output: `status` among `done`, `likely_done`, `stuck`, `needs_confirmation`,
`needs_login`, `blocked`, `max_steps`, `timeout`. Plus `page_id`, `url`,
`title`, `steps` (action, target label, confidence, goal probability),
`candidates` (up to five labels, only when stuck or ambiguous), `pending` (the
withheld action, only on needs_confirmation), and `usage` (Jev calls, tokens,
wall-clock). Never page text.

`page_id` is required by the follow-up call. Verified during the build: with
page id routing on (the default), the stock page-scoped tools reject a call
without `pageId` rather than falling back to the selected tab. The id is an
internal counter invisible outside the process, so reach parses it from the
warm-up `list_pages` reply and hands it back. Ids are per tab and survive
navigation.

## Limits

- Navigation only. Jev never verifies the bug.
- Jev never generates text. Typed values come from the `values` map. Only the
  map's keys are sent to Jev; the values go to the browser only.
- Irreversible detection is Jev plus a keyword list, with a per-call override.
  Native confirm and prompt dialogs count as irreversible. Alerts are dismissed
  and logged.
- Reach holds its own mutex and does not share the stock tool mutex. Parallel
  browser calls are unsupported.
- Main frame plus open shadow roots. Iframes, uploads, drag are later.
- The stock `--headless` flag controls visibility. `JEV_REACH_LOG=1` prints one
  stderr line per step.

## Tests

- Offline unit tests for ranking, chunking, binding options, status logic, the
  keyword guard, fingerprint diffs, and the selected-page parser. Jev mocked.
- One end-to-end run behind `JEV_REACH_E2E=1` with a real key: a local fixture
  with a cookie banner and a settings link that logs to the console. Reach
  first, then `list_console_messages`, and the walk's messages must be there.
