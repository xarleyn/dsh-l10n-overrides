import type { Diagnostics } from "../registry/diagnostics.js";
import type { DomTranslationAttribute, DomTranslationRule } from "../types.js";

const DOM_TRANSLATION_ATTRIBUTES = new Set<DomTranslationAttribute>([
  "placeholder",
  "title",
  "aria-label",
  "alt",
]);
const SHARED_PROTECTED_SURFACES = [
  "[contenteditable]",
  "[data-no-translate]",
  "[data-message-id]",
  '[data-testid*="conversation" i]',
  '[data-testid*="message" i]',
  '[data-testid*="markdown" i]',
  '[data-testid*="editor" i]',
  '[data-testid*="terminal" i]',
  '[data-testid*="prompt" i]',
  '[data-testid*="composer" i]',
  '[class*="conversation" i]',
  '[class*="message" i]',
  '[class*="markdown" i]',
  '[class*="editor" i]',
  '[class*="terminal" i]',
  '[class*="prompt" i]',
];
const CODE_LIKE_PROTECTED_SURFACES = [
  "pre",
  "code",
  "kbd",
  "samp",
  "script",
  "style",
];
const TEXT_PROTECTED_SURFACE_SELECTOR = [
  "input",
  "textarea",
  ...CODE_LIKE_PROTECTED_SURFACES,
  ...SHARED_PROTECTED_SURFACES,
].join(",");
const ATTRIBUTE_PROTECTED_SURFACE_SELECTOR = [
  ...CODE_LIKE_PROTECTED_SURFACES,
  ...SHARED_PROTECTED_SURFACES,
].join(",");

interface ScopeRules {
  readonly scope: string;
  readonly text: ReadonlyMap<string, DomTranslationRule>;
  readonly attributes: ReadonlyMap<
    DomTranslationAttribute,
    ReadonlyMap<string, DomTranslationRule>
  >;
}

interface TextOwnership {
  original: string;
  translated: string;
}

interface AttributeOwnership {
  wasPresent: boolean;
  original: string | null;
  translated: string;
}

export class DomTranslator {
  readonly #scopes: readonly ScopeRules[];
  readonly #attributeFilter: readonly DomTranslationAttribute[];
  readonly #textOwnership = new WeakMap<Node, TextOwnership>();
  readonly #ownedTextNodes = new Set<Node>();
  readonly #attributeOwnership = new WeakMap<
    Element,
    Map<string, AttributeOwnership>
  >();
  readonly #ownedAttributeElements = new Set<Element>();
  readonly #reportedFailures = new Set<string>();
  #locale: string | undefined;
  #disposed = false;
  #observer: MutationObserver | undefined;

  constructor(
    private readonly document: Document,
    rules: readonly DomTranslationRule[],
    private readonly diagnostics: Diagnostics,
  ) {
    const scopes = new Map<
      string,
      {
        text: Map<string, DomTranslationRule>;
        attributes: Map<
          DomTranslationAttribute,
          Map<string, DomTranslationRule>
        >;
      }
    >();
    for (const rule of rules) {
      let scopeRules = scopes.get(rule.scope);
      if (scopeRules === undefined) {
        scopeRules = { text: new Map(), attributes: new Map() };
        scopes.set(rule.scope, scopeRules);
      }
      if (!scopeRules.text.has(rule.source)) {
        scopeRules.text.set(rule.source, rule);
      }
      for (const attribute of rule.attributes ?? []) {
        if (!DOM_TRANSLATION_ATTRIBUTES.has(attribute)) continue;
        let attributeRules = scopeRules.attributes.get(attribute);
        if (attributeRules === undefined) {
          attributeRules = new Map();
          scopeRules.attributes.set(attribute, attributeRules);
        }
        if (!attributeRules.has(rule.source)) {
          attributeRules.set(rule.source, rule);
        }
      }
    }
    const indexedScopes = Array.from(scopes, ([scope, indexed]) => ({
      scope,
      text: indexed.text,
      attributes: indexed.attributes,
    }));
    this.#scopes = indexedScopes.filter(({ scope }) => {
      if (scope === "global") return true;
      try {
        this.document.createDocumentFragment().querySelector(scope);
        return true;
      } catch {
        this.diagnostics.error(
          "invalid_dom_scope",
          `Invalid DOM translation scope "${scope}" was ignored.`,
        );
        return false;
      }
    });
    this.#attributeFilter = Array.from(
      new Set(this.#scopes.flatMap(({ attributes }) => [...attributes.keys()])),
    );
  }

  setLocale(locale: string): void {
    if (this.#disposed || this.#locale === locale) return;
    const previousLocale = this.#locale;
    this.#locale = locale;
    if (locale !== "en") {
      if (previousLocale === "en") {
        this.#disconnectObserver();
        this.#restoreOwnedValues();
      }
      return;
    }

    for (const scopeRules of this.#scopes) {
      let roots: readonly Element[];
      try {
        roots =
          scopeRules.scope === "global"
            ? this.document.body === null
              ? []
              : [this.document.body]
            : Array.from(this.document.querySelectorAll(scopeRules.scope));
      } catch {
        this.#reportOnce(
          `initial-query:${scopeRules.scope}`,
          "dom_translation_failed",
          `DOM translation roots could not be found for scope "${scopeRules.scope}".`,
        );
        continue;
      }
      for (const root of roots) this.#translateRoot(root, scopeRules);
    }
    this.#connectObserver();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disconnectObserver();
    this.#restoreOwnedValues();
    this.#disposed = true;
  }

  #disconnectObserver(): void {
    try {
      this.#observer?.disconnect();
    } catch {}
    this.#observer = undefined;
  }

  #restoreOwnedValues(): void {
    for (const node of this.#ownedTextNodes) {
      const ownership = this.#textOwnership.get(node);
      try {
        if (
          ownership !== undefined &&
          node.textContent === ownership.translated
        ) {
          node.textContent = ownership.original;
        }
      } catch {}
      this.#textOwnership.delete(node);
    }
    this.#ownedTextNodes.clear();

    for (const element of this.#ownedAttributeElements) {
      const attributes = this.#attributeOwnership.get(element);
      if (attributes !== undefined) {
        for (const [attribute, ownership] of attributes) {
          try {
            if (element.getAttribute(attribute) !== ownership.translated) {
              continue;
            }
            if (ownership.wasPresent) {
              element.setAttribute(attribute, ownership.original ?? "");
            } else {
              element.removeAttribute(attribute);
            }
          } catch {}
        }
      }
      this.#attributeOwnership.delete(element);
    }
    this.#ownedAttributeElements.clear();
  }

  #connectObserver(): void {
    if (this.#scopes.length === 0) return;
    let body: HTMLElement | null;
    let MutationObserverConstructor: typeof MutationObserver | undefined;
    try {
      body = this.document.body;
      MutationObserverConstructor = this.document.defaultView?.MutationObserver;
    } catch {
      this.#reportOnce(
        "dom-environment",
        "dom_translation_failed",
        "DOM translation APIs are unavailable.",
      );
      return;
    }
    if (body === null || MutationObserverConstructor === undefined) {
      this.#reportOnce(
        "dom-environment",
        "dom_translation_failed",
        "DOM translation observation is unavailable.",
      );
      return;
    }
    try {
      this.#observer = new MutationObserverConstructor((records) => {
        try {
          this.#processMutations(records);
        } catch {
          this.#reportOnce(
            "mutation-callback",
            "dom_translation_failed",
            "Dynamic DOM translation failed.",
          );
        }
      });
      this.#observer.observe(body, {
        childList: true,
        subtree: true,
        characterData: true,
        ...(this.#attributeFilter.length === 0
          ? {}
          : {
              attributes: true,
              attributeFilter: [...this.#attributeFilter],
            }),
      });
    } catch {
      this.#observer = undefined;
      this.#reportOnce(
        "observer-construction",
        "dom_translation_failed",
        "DOM mutation observation could not be started.",
      );
    }
  }

  #processMutations(records: readonly MutationRecord[]): void {
    if (this.#disposed || this.#locale !== "en") return;
    for (const record of records) {
      try {
        if (record.type === "characterData") {
          this.#translateChangedText(record.target);
          continue;
        }
        if (record.type === "attributes") {
          if (
            record.target instanceof Element &&
            record.attributeName !== null
          ) {
            this.#translateChangedAttribute(
              record.target,
              record.attributeName,
            );
          }
          continue;
        }
      } catch {
        this.#reportMutationFailure();
        continue;
      }
      for (const node of record.addedNodes) {
        try {
          this.#translateAddedNode(node);
        } catch {
          this.#reportMutationFailure();
        }
      }
    }
  }

  #reportMutationFailure(): void {
    this.#reportOnce(
      "mutation-callback",
      "dom_translation_failed",
      "Dynamic DOM translation failed.",
    );
  }

  #translateChangedText(node: Node): void {
    const parent = node.parentElement;
    if (parent === null) return;
    for (const scopeRules of this.#scopes) {
      if (this.#isInScope(parent, scopeRules.scope)) {
        this.#translateText(node, scopeRules.text);
      }
    }
  }

  #translateChangedAttribute(element: Element, attributeName: string): void {
    for (const scopeRules of this.#scopes) {
      const rules = scopeRules.attributes.get(
        attributeName as DomTranslationAttribute,
      );
      if (rules !== undefined && this.#isInScope(element, scopeRules.scope)) {
        this.#translateAttribute(element, attributeName, rules);
      }
    }
  }

  #translateAddedNode(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      this.#translateChangedText(node);
      return;
    }
    if (!(node instanceof Element)) return;
    for (const scopeRules of this.#scopes) {
      if (this.#isInScope(node, scopeRules.scope)) {
        this.#translateRoot(node, scopeRules);
        continue;
      }
      if (scopeRules.scope === "global") continue;
      for (const root of node.querySelectorAll(scopeRules.scope)) {
        this.#translateRoot(root, scopeRules);
      }
    }
  }

  #translateRoot(root: Element, rules: ScopeRules): void {
    try {
      this.#translateTree(root, rules);
    } catch {
      this.#reportOnce(
        `root:${rules.scope}`,
        "dom_translation_failed",
        `DOM translation failed for a root in scope "${rules.scope}".`,
      );
    }
  }

  #isInScope(element: Element, scope: string): boolean {
    return scope === "global"
      ? this.document.body?.contains(element) === true
      : element.closest(scope) !== null;
  }

  #translateTree(root: Element, rules: ScopeRules): void {
    this.#translateAttributes(root, rules.attributes);
    for (const element of root.querySelectorAll("*")) {
      this.#translateAttributes(element, rules.attributes);
    }

    const walker = this.document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node !== null) {
      this.#translateText(node, rules.text);
      node = walker.nextNode();
    }
  }

  #translateText(
    node: Node,
    rules: ReadonlyMap<string, DomTranslationRule>,
  ): void {
    const value = node.textContent ?? "";
    let ownership = this.#textOwnership.get(node);
    if (ownership !== undefined && value === ownership.translated) return;
    const rule = rules.get(value.trim());
    const parent = node.parentElement;
    if (
      rule === undefined ||
      parent === null ||
      parent.closest(TEXT_PROTECTED_SURFACE_SELECTOR) !== null
    ) {
      return;
    }
    const start = value.search(/\S/);
    const end = value.search(/\s*$/);
    const translated = `${value.slice(0, start)}${rule.target}${value.slice(end)}`;
    if (ownership === undefined) {
      ownership = { original: value, translated };
      this.#textOwnership.set(node, ownership);
      this.#ownedTextNodes.add(node);
    } else {
      ownership.original = value;
      ownership.translated = translated;
    }
    node.textContent = translated;
  }

  #translateAttributes(
    element: Element,
    rules: ScopeRules["attributes"],
  ): void {
    if (
      rules.size === 0 ||
      element.closest(ATTRIBUTE_PROTECTED_SURFACE_SELECTOR) !== null
    ) {
      return;
    }
    for (const [attribute, attributeRules] of rules) {
      this.#translateAttribute(element, attribute, attributeRules);
    }
  }

  #translateAttribute(
    element: Element,
    attribute: string,
    rules: ReadonlyMap<string, DomTranslationRule>,
  ): void {
    if (element.closest(ATTRIBUTE_PROTECTED_SURFACE_SELECTOR) !== null) return;
    const value = element.getAttribute(attribute);
    if (value === null) return;
    let attributes = this.#attributeOwnership.get(element);
    let ownership = attributes?.get(attribute);
    if (ownership !== undefined && value === ownership.translated) return;
    const rule = rules.get(value);
    if (rule === undefined) return;

    if (attributes === undefined) {
      attributes = new Map();
      this.#attributeOwnership.set(element, attributes);
      this.#ownedAttributeElements.add(element);
    }
    if (ownership === undefined) {
      ownership = {
        wasPresent: element.hasAttribute(attribute),
        original: value,
        translated: rule.target,
      };
      attributes.set(attribute, ownership);
    } else {
      ownership.wasPresent = element.hasAttribute(attribute);
      ownership.original = value;
      ownership.translated = rule.target;
    }
    element.setAttribute(attribute, rule.target);
  }

  #reportOnce(key: string, code: string, message: string): void {
    if (this.#reportedFailures.has(key)) return;
    this.#reportedFailures.add(key);
    try {
      this.diagnostics.error(code, message);
    } catch {}
  }
}
