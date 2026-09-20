/**
 * The in-page collector.
 *
 * `collectSnapshot` is serialised by puppeteer and run inside the page, so it
 * must be self-contained: no imports, no closures over module state. It stores
 * the element references on `window.__jevReach` so a later evaluateHandle can
 * turn a numeric ref back into an element to act on.
 */

import type { Candidate, CandidateKind } from "./lib.js";

export interface RawSnapshot {
  url: string;
  title: string;
  /** Visible text, whitespace collapsed, capped. */
  text: string;
  /** Joined current values of form controls, for change detection. */
  inputs: string;
  candidates: Candidate[];
  /** How many interactive elements were found before any cap. */
  total: number;
}

export interface CollectOptions {
  maxText: number;
  maxCandidates: number;
}

export type PageRef = Element | { select: HTMLSelectElement; value: string };

declare global {
  interface Window {
    __jevReach?: PageRef[];
  }
}

export function collectSnapshot(opts: CollectOptions): RawSnapshot {
  const INTERACTIVE =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, ' +
    '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], ' +
    '[role="checkbox"], [role="radio"], [role="switch"], [role="option"], [role="combobox"], [role="treeitem"], ' +
    '[contenteditable="true"], [contenteditable=""], [tabindex]:not([tabindex="-1"])';

  const refs: PageRef[] = [];
  const out: Candidate[] = [];
  const seen = new Set<Element>();
  const vh = window.innerHeight;
  const vw = window.innerWidth;

  const clean = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    return true;
  };

  const inViewport = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  };

  const disabled = (el: Element): boolean => {
    if ((el as HTMLButtonElement).disabled) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    return false;
  };

  const labelOf = (el: Element): string => {
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const txt = by
        .split(/\s+/)
        .map((id) => clean(document.getElementById(id)?.textContent))
        .filter(Boolean)
        .join(" ");
      if (txt) return txt;
    }
    const input = el as HTMLInputElement;
    if (input.labels && input.labels.length > 0) {
      const txt = clean(
        Array.from(input.labels)
          .map((l) => l.textContent)
          .join(" "),
      );
      if (txt) return txt;
    }
    const ph = clean(el.getAttribute("placeholder"));
    if (ph) return ph;
    const inner = clean((el as HTMLElement).innerText);
    if (inner) return inner;
    const title = clean(el.getAttribute("title"));
    if (title) return title;
    const img = el.querySelector("img[alt]");
    const alt = clean(img?.getAttribute("alt"));
    if (alt) return alt;
    const value = clean(el.getAttribute("value"));
    if (value) return value;
    const name = clean(el.getAttribute("name"));
    if (name) return name;
    return clean(el.id) || el.tagName.toLowerCase();
  };

  const tagOf = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    if (tag === "input") {
      const type = (el as HTMLInputElement).type || "text";
      return `input[${type}]`;
    }
    if (tag === "a") return "link";
    if (role && tag !== "button" && tag !== "select" && tag !== "textarea") return role;
    return tag;
  };

  const kindOf = (el: Element): CandidateKind => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    if (tag === "textarea" || el.getAttribute("contenteditable") !== null) return "type";
    if (tag === "input") {
      const type = (el as HTMLInputElement).type;
      if (type === "checkbox" || type === "radio") return "toggle";
      if (type === "submit" || type === "button" || type === "reset" || type === "image" || type === "file" || type === "color" || type === "range") return "click";
      return "type";
    }
    if (role === "checkbox" || role === "radio" || role === "switch") return "toggle";
    if (role === "combobox" && (el as HTMLElement).isContentEditable) return "type";
    return "click";
  };

  const stateOf = (el: Element): string | undefined => {
    const bits: string[] = [];
    const input = el as HTMLInputElement;
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && (input.type === "checkbox" || input.type === "radio")) bits.push(input.checked ? "checked" : "unchecked");
    const ariaChecked = el.getAttribute("aria-checked");
    if (ariaChecked) bits.push(ariaChecked === "true" ? "checked" : "unchecked");
    const expanded = el.getAttribute("aria-expanded");
    if (expanded) bits.push(expanded === "true" ? "expanded" : "collapsed");
    const selected = el.getAttribute("aria-selected");
    if (selected === "true") bits.push("selected");
    if (tag === "input" || tag === "textarea") {
      const v = clean(input.value);
      if (v && input.type !== "password") bits.push(`value: ${v.slice(0, 40)}`);
      else if (v) bits.push("filled");
    }
    return bits.length ? bits.join(", ") : undefined;
  };

  const push = (el: Element): void => {
    if (seen.has(el)) return;
    seen.add(el);
    if (!visible(el) || disabled(el)) return;
    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      const select = el as HTMLSelectElement;
      const selectLabel = labelOf(select);
      for (const opt of Array.from(select.options)) {
        if (opt.disabled) continue;
        refs.push({ select, value: opt.value });
        out.push({
          ref: refs.length - 1,
          tag: "option",
          kind: "select",
          label: `${clean(opt.textContent) || opt.value} in select "${selectLabel}"`,
          inViewport: inViewport(select),
          ...(opt.selected ? { state: "selected" } : {}),
        });
      }
      return;
    }
    refs.push(el);
    const c: Candidate = {
      ref: refs.length - 1,
      tag: tagOf(el),
      kind: kindOf(el),
      label: labelOf(el),
      inViewport: inViewport(el),
    };
    const state = stateOf(el);
    if (state) c.state = state;
    if (c.kind === "type") {
      const field = el as HTMLInputElement;
      const current = tag === "input" || tag === "textarea" ? field.value : (el as HTMLElement).innerText;
      const v = clean(current);
      if (v) c.filled = true;
      if (!(tag === "input" && field.type === "password")) c.value = v;
    }
    if (tag === "a") {
      const href = (el as HTMLAnchorElement).getAttribute("href") ?? "";
      if (href && !href.startsWith("javascript:")) c.href = href;
    }
    out.push(c);
  };

  const walk = (root: Document | ShadowRoot | Element): void => {
    const all = root.querySelectorAll("*");
    for (const el of Array.from(all)) {
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el.matches(INTERACTIVE)) push(el);
    }
  };
  walk(document);

  const total = out.length;
  const capped = out.slice(0, opts.maxCandidates);
  window.__jevReach = refs;

  const fields = Array.from(document.querySelectorAll("input, textarea, select")) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
  const inputs = fields.map((f) => ((f as HTMLInputElement).type === "password" ? (f.value ? "*" : "") : f.value)).join("");

  const text = clean(document.body?.innerText).slice(0, opts.maxText);

  return { url: location.href, title: document.title, text, inputs, candidates: capped, total };
}
