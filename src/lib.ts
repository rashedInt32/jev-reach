/**
 * Pure helpers for jev-reach. No browser, no network, no process state.
 *
 * Everything the loop decides is expressed here as a function of plain data,
 * so the status logic, the candidate ranking, and the guards are testable
 * without Chrome or a TypeSafe key.
 */

// ── Limits ──────────────────────────────────────────────────────────────────

/** A Choice question accepts 255 options. One is reserved for "none". */
export const MAX_OPTIONS = 254;

export const DEFAULT_MAX_STEPS = 15;
export const DEFAULT_SETTLE_MS = 500;
export const DEFAULT_SETTLE_CAP_MS = 5_000;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_TEXT_CHARS = 3_000;
export const STUCK_AFTER = 3;
export const CANDIDATE_LABELS = 5;

export interface Thresholds {
  done: number;
  likelyDone: number;
  irreversible: number;
  login: number;
  blocked: number;
  /** Below this element confidence a click is reported as ambiguous. */
  ambiguous: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  done: 0.85,
  likelyDone: 0.6,
  irreversible: 0.5,
  login: 0.7,
  blocked: 0.7,
  ambiguous: 0.2,
};

// ── Candidates ──────────────────────────────────────────────────────────────

export type CandidateKind = "click" | "type" | "select" | "toggle";

/** One interactive element as the in-page collector reports it. */
export interface Candidate {
  /** Index into the page-side element array; the handle for acting. */
  ref: number;
  tag: string;
  kind: CandidateKind;
  label: string;
  inViewport: boolean;
  /** Extra state worth telling Jev: checked, expanded, current value. */
  state?: string;
  href?: string;
  /** Current value of a text-like field, absent for masked fields. */
  value?: string;
  /** True when a field holds any value, including masked ones. */
  filled?: boolean;
}

/** A per-run identity for a field that survives re-snapshotting, unlike `ref`. */
export function fieldSignature(c: Candidate): string {
  return `${c.tag}|${c.label}`;
}

/** In-viewport elements first, original order otherwise. */
export function rankCandidates(candidates: readonly Candidate[]): Candidate[] {
  const inView: Candidate[] = [];
  const rest: Candidate[] = [];
  for (const c of candidates) (c.inViewport ? inView : rest).push(c);
  return [...inView, ...rest];
}

export function optionKey(c: Pick<Candidate, "ref">): string {
  return `e${c.ref}`;
}

export function refFromKey(key: string): number | null {
  const m = /^e(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

/** The one-line description Jev sees for an element. */
export function describeCandidate(c: Candidate): string {
  const parts = [`${c.tag} "${truncate(c.label, 80)}"`];
  if (c.state) parts.push(`(${c.state})`);
  if (c.href) parts.push(`-> ${truncate(c.href, 60)}`);
  if (!c.inViewport) parts.push("[below the fold]");
  return parts.join(" ");
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Joint field-and-value options for typing. Jev binds a supplied value to a
 * field in one pick, so the field and the value can never disagree.
 * Only the value's name is shown; the value itself never reaches Jev.
 *
 * `skip` drops pairs that are already satisfied. Without it Jev happily
 * re-types the email into the email field forever, which the live run showed.
 */
export function buildBindingOptions(
  typeables: readonly Candidate[],
  valueKeys: readonly string[],
  skip: (c: Candidate, key: string) => boolean = () => false,
): Record<string, string> {
  const options: Record<string, string> = {};
  for (const c of typeables) {
    for (const key of valueKeys) {
      if (skip(c, key)) continue;
      options[`${optionKey(c)}|${key}`] = `Type the supplied value named "${key}" into ${describeCandidate(c)}`;
    }
  }
  return options;
}

/**
 * Value names that already sit in some field. A value goes into one field, so
 * once it is placed it leaves the menu for every other field too. Without this
 * the live run bound the email to the password field once the password was in.
 */
export function consumedKeys(candidates: readonly Candidate[], valueKeys: readonly string[], values: Record<string, string>, typed: ReadonlySet<string>): Set<string> {
  const consumed = new Set<string>();
  for (const key of valueKeys) {
    if (candidates.some((c) => c.kind === "type" && bindingSatisfied(c, key, values, typed))) consumed.add(key);
  }
  return consumed;
}

/**
 * A binding is satisfied when the field visibly holds the value, or when the
 * field is masked, holds something, and this run already typed that key there.
 */
export function bindingSatisfied(c: Candidate, key: string, values: Record<string, string>, typed: ReadonlySet<string>): boolean {
  const wanted = values[key];
  if (wanted === undefined) return true;
  if (c.value !== undefined) return c.value === wanted;
  return c.filled === true && typed.has(`${fieldSignature(c)}|${key}`);
}

export function parseBinding(choice: string): { ref: number; key: string } | null {
  const bar = choice.indexOf("|");
  if (bar < 0) return null;
  const ref = refFromKey(choice.slice(0, bar));
  const key = choice.slice(bar + 1);
  if (ref === null || key.length === 0) return null;
  return { ref, key };
}

// ── Guards ──────────────────────────────────────────────────────────────────

/**
 * Labels that usually mean money moves, something is sent, or data is gone.
 * Jev's own irreversible probability is the main signal; this is a backstop.
 */
const IRREVERSIBLE =
  /\b(pay|pay now|purchase|buy now|place (?:the )?order|checkout|check out|complete (?:the )?order|confirm (?:the )?order|submit (?:the )?order|delete|send|publish|transfer|unsubscribe)\b/i;

export function looksIrreversible(label: string): boolean {
  return IRREVERSIBLE.test(label);
}

// ── Page fingerprint ────────────────────────────────────────────────────────

export interface PageFingerprintInput {
  url: string;
  text: string;
  inputs: string;
}

/** Stable, cheap string for "did anything change" between steps. */
export function fingerprint(p: PageFingerprintInput): string {
  return `${p.url} ${hash(p.text)} ${hash(p.inputs)}`;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

// ── Selected page from list_pages ───────────────────────────────────────────

export interface ListedPage {
  id: number;
  url: string;
  selected: boolean;
}

/**
 * Parse the stock `list_pages` text into page ids and URLs.
 *
 * Lines look like `3: Title (https://x) [selected]` or `3: https://x`, with an
 * optional ` isolatedContext=name` suffix. The id is what the stock page-scoped
 * tools require as `pageId`, and it is invisible to anything outside the
 * process, so reach has to hand it back to the caller.
 * Pinned to chrome-devtools-mcp 1.9.0; a format change yields an empty list
 * and the loop falls back to the first tab without a page id.
 */
export function parsePages(text: string): ListedPage[] {
  const pages: ListedPage[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = /^(\d+):\s+(.*)$/.exec(line);
    if (!m) continue;
    const id = Number(m[1]);
    let label = (m[2] ?? "").replace(/\s+isolatedContext=\S+$/, "").trim();
    const selected = /\[selected\]\s*$/.test(label);
    label = label.replace(/\s*\[selected\]\s*$/, "").trim();
    const paren = /\(([^()]*)\)\s*$/.exec(label);
    if (paren?.[1]) label = paren[1];
    if (label.length === 0) continue;
    pages.push({ id, url: label, selected });
  }
  return pages;
}

export function parseSelectedPage(text: string): ListedPage | null {
  return parsePages(text).find((p) => p.selected) ?? null;
}

// ── Stock navigation ────────────────────────────────────────────────────────

/**
 * Navigation budget for stock `new_page` and `navigate_page` calls that set no
 * timeout. The stock default is 10 s, which a dev server compiling a route on
 * first hit often misses: the page still loads, but the caller sees an error
 * and navigates again.
 */
export const DEFAULT_NAV_TIMEOUT_MS = 30_000;

/**
 * The id of the tab a `new_page` call should load into instead of opening a
 * second one, or null to open a new tab as usual.
 *
 * Chrome starts with one `about:blank` tab, so a first `new_page` otherwise
 * leaves that tab idle and puts the URL in tab 2. Reuse only applies when the
 * blank tab is the only page and sits in the default context: a call naming an
 * `isolatedContext` wants its own cookies and storage, and a background call
 * must not take over the foreground tab.
 */
export function blankTabToReuse(listText: string, params: { isolatedContext?: unknown; background?: unknown }): number | null {
  if (params.isolatedContext || params.background) return null;
  const lines = listText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+:\s/.test(l));
  if (lines.length !== 1 || /\sisolatedContext=\S+$/.test(lines[0] as string)) return null;
  const [page] = parsePages(lines[0] as string);
  return page?.url === "about:blank" ? page.id : null;
}

// ── Step decision ───────────────────────────────────────────────────────────

export type Action = "click" | "type" | "select" | "scroll_down" | "scroll_up" | "back" | "wait" | "done";
export const ACTIONS: Record<Action, string> = {
  click: "Click the chosen element.",
  type: "Type one of the supplied values into a field.",
  select: "Choose the chosen option inside a dropdown.",
  scroll_down: "Scroll down to reveal more of the page.",
  scroll_up: "Scroll up.",
  back: "Go back to the previous page.",
  wait: "Wait for the page to finish loading or updating.",
  done: "The goal is already met; stop.",
};

export interface StepAnswers {
  element: { choice: string; confidence: number };
  action: { choice: Action; confidence: number };
  binding?: { choice: string; confidence: number };
  goal: number;
  irreversible: number;
  login: number;
  blocked: number;
}

export type FinalStatus = "done" | "likely_done" | "stuck" | "needs_confirmation" | "needs_login" | "blocked" | "max_steps" | "timeout";

export type Decision =
  | { kind: "finish"; status: "done" | "likely_done" | "blocked" | "needs_login" }
  | { kind: "act"; action: Action; target?: Candidate; valueKey?: string }
  | { kind: "confirm"; action: Action; target: Candidate; reason: string }
  | { kind: "ambiguous"; reason: string }
  | { kind: "noop"; reason: string };

export interface DecisionContext {
  candidates: readonly Candidate[];
  hasValues: boolean;
  allowIrreversible: boolean;
  thresholds?: Thresholds;
}

/**
 * Turn one round of answers into what the loop does next.
 *
 * Order matters: a blocked page or a reached goal ends the walk before any
 * element is touched; a login wall without credentials ends it before Jev
 * tries to type into a password field it has no value for.
 */
export function decideStep(a: StepAnswers, ctx: DecisionContext): Decision {
  const t = ctx.thresholds ?? DEFAULT_THRESHOLDS;
  const byKey = new Map(ctx.candidates.map((c) => [optionKey(c), c] as const));

  if (a.blocked >= t.blocked) return { kind: "finish", status: "blocked" };
  if (a.goal >= t.done) return { kind: "finish", status: "done" };
  if (a.action.choice === "done") {
    if (a.goal >= t.likelyDone) return { kind: "finish", status: "likely_done" };
    return { kind: "noop", reason: "Jev chose done but the goal probability is low." };
  }
  if (a.login >= t.login && !ctx.hasValues) return { kind: "finish", status: "needs_login" };

  const action = a.action.choice;
  if (action === "scroll_down" || action === "scroll_up" || action === "back" || action === "wait") {
    return { kind: "act", action };
  }

  if (action === "type") {
    if (!ctx.hasValues) return { kind: "ambiguous", reason: "Jev wants to type but no values were supplied." };
    const bound = a.binding && a.binding.choice !== "none" ? parseBinding(a.binding.choice) : null;
    if (!bound) return { kind: "ambiguous", reason: "Jev wants to type but did not bind a value to a field." };
    const target = byKey.get(optionKey({ ref: bound.ref }));
    if (!target) return { kind: "ambiguous", reason: "The bound field is not among the candidates." };
    return { kind: "act", action: "type", target, valueKey: bound.key };
  }

  // click or select
  if (a.element.choice === "none") return { kind: "ambiguous", reason: "Jev picked no element for a click." };
  const target = byKey.get(a.element.choice);
  if (!target) return { kind: "ambiguous", reason: "Jev picked an element that was not offered." };
  if (a.element.confidence < t.ambiguous) return { kind: "ambiguous", reason: "Element confidence is too low to act on." };

  const resolved: Action = target.kind === "select" ? "select" : "click";
  const risky = a.irreversible >= t.irreversible || looksIrreversible(target.label);
  if (risky && !ctx.allowIrreversible) {
    const why =
      a.irreversible >= t.irreversible
        ? `Jev rates this action irreversible at ${a.irreversible.toFixed(2)}.`
        : "The label reads like an order, payment, send, delete, or publish.";
    return { kind: "confirm", action: resolved, target, reason: why };
  }
  return { kind: "act", action: resolved, target };
}

/** Status when the step budget or the clock runs out. */
export function statusOnBudget(lastGoal: number | null, kind: "max_steps" | "timeout", t: Thresholds = DEFAULT_THRESHOLDS): FinalStatus {
  if (lastGoal !== null && lastGoal >= t.likelyDone) return "likely_done";
  return kind;
}

// ── Small utilities ─────────────────────────────────────────────────────────

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 3))}...`;
}

export function topLabels(candidates: readonly Candidate[], n = CANDIDATE_LABELS): string[] {
  return candidates.slice(0, n).map(describeCandidate);
}

/** A tiny async mutex so two reach calls never interleave on one page. */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.#tail;
    this.#tail = this.#tail.then(() => next);
    await prev;
    return release;
  }
}
