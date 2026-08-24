import type { Diagnostics } from "../registry/diagnostics.js";
import type { DomTranslationAttribute, DomTranslationRule } from "../types.js";

const DOM_TRANSLATION_ATTRIBUTES = new Set<DomTranslationAttribute>([
  "placeholder",
  "title",
  "aria-label",
  "alt",
]);
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const SHOW_ELEMENT_AND_TEXT = 5;
const SCOPE_AND_PROTECTION_ATTRIBUTES = [
  "class",
  "id",
  "contenteditable",
  "data-no-translate",
  "data-message-id",
  "data-testid",
];
const SCOPE_ATTRIBUTE_PATTERN = /\[\s*([^\s~|^$*=\]]+)/g;
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
  scope: string;
}

interface AttributeOwnership {
  wasPresent: boolean;
  original: string | null;
  translated: string;
  scope: string;
}

export class DomTranslator {
  readonly #scopes: readonly ScopeRules[];
  readonly #attributeFilter: readonly string[];
  readonly #scopeAndProtectionAttributes: ReadonlySet<string>;
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
    const translationAttributes = this.#scopes.flatMap(({ attributes }) => [
      ...attributes.keys(),
    ]);
    const scopeAndProtectionAttributes = new Set(
      SCOPE_AND_PROTECTION_ATTRIBUTES,
    );
    for (const { scope } of this.#scopes) {
      if (scope === "global") continue;
      for (const match of scope.matchAll(SCOPE_ATTRIBUTE_PATTERN)) {
        const attribute = match[1];
        if (attribute !== undefined) {
          scopeAndProtectionAttributes.add(attribute.toLowerCase());
        }
      }
    }
    this.#scopeAndProtectionAttributes = scopeAndProtectionAttributes;
    this.#attributeFilter = Array.from(
      new Set([...translationAttributes, ...scopeAndProtectionAttributes]),
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
        roots = this.#topmostRoots(roots);
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
        attributes: true,
        attributeFilter: [...this.#attributeFilter],
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
    const touchedSubtrees = new Set<Node>();
    for (const record of records) {
      try {
        if (record.type === "characterData") {
          this.#translateChangedText(record.target);
          continue;
        }
        if (record.type === "attributes") {
          if (
            record.target.nodeType === ELEMENT_NODE &&
            record.attributeName !== null
          ) {
            const element = record.target as Element;
            if (this.#scopeAndProtectionAttributes.has(record.attributeName)) {
              this.#reconcileSubtree(element);
              if (this.#isConnectedToDocument(element)) {
                this.#translateAddedNode(element);
              }
            } else {
              this.#translateChangedAttribute(element, record.attributeName);
            }
          }
          continue;
        }
      } catch {
        this.#reportMutationFailure();
        continue;
      }
      for (const node of record.removedNodes) touchedSubtrees.add(node);
      for (const node of record.addedNodes) {
        touchedSubtrees.add(node);
      }
    }
    for (const node of touchedSubtrees) {
      try {
        this.#reconcileSubtree(node);
        if (this.#isConnectedToDocument(node)) this.#translateAddedNode(node);
      } catch {
        this.#reportMutationFailure();
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
    this.#reconcileTextOwnership(node);
    const parent = node.parentElement;
    if (parent === null) return;
    for (const scopeRules of this.#scopes) {
      if (this.#isInScope(parent, scopeRules.scope)) {
        this.#translateText(node, scopeRules);
      }
    }
  }

  #translateChangedAttribute(element: Element, attributeName: string): void {
    this.#reconcileAttributeOwnership(element, attributeName);
    for (const scopeRules of this.#scopes) {
      const rules = scopeRules.attributes.get(
        attributeName as DomTranslationAttribute,
      );
      if (rules !== undefined && this.#isInScope(element, scopeRules.scope)) {
        this.#translateAttribute(
          element,
          attributeName,
          rules,
          scopeRules.scope,
        );
      }
    }
  }

  #translateAddedNode(node: Node): void {
    if (node.nodeType === TEXT_NODE) {
      this.#translateChangedText(node);
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const element = node as Element;
    for (const scopeRules of this.#scopes) {
      if (this.#isInScope(element, scopeRules.scope)) {
        this.#translateRoot(element, scopeRules);
        continue;
      }
      if (scopeRules.scope === "global") continue;
      const roots = this.#topmostRoots([
        ...element.querySelectorAll(scopeRules.scope),
      ]);
      for (const root of roots) {
        this.#translateRoot(root, scopeRules);
      }
    }
  }

  #topmostRoots(roots: readonly Element[]): readonly Element[] {
    if (roots.length < 2) return roots;
    const candidates = new Set(roots);
    return roots.filter((root) => {
      let ancestor = root.parentElement;
      while (ancestor !== null) {
        if (candidates.has(ancestor)) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    });
  }

  #reconcileSubtree(root: Node): void {
    this.#reconcileOwnedNode(root);
    if (root.nodeType !== ELEMENT_NODE) return;

    const walker = this.document.createTreeWalker(root, SHOW_ELEMENT_AND_TEXT);
    let node = walker.nextNode();
    while (node !== null) {
      try {
        this.#reconcileOwnedNode(node);
      } catch {
        this.#reportMutationFailure();
      }
      node = walker.nextNode();
    }
  }

  #reconcileOwnedNode(node: Node): void {
    if (node.nodeType === TEXT_NODE) {
      this.#reconcileTextOwnership(node);
    } else if (node.nodeType === ELEMENT_NODE) {
      this.#reconcileElementOwnership(node as Element);
    }
  }

  #reconcileTextOwnership(node: Node): void {
    const ownership = this.#textOwnership.get(node);
    if (ownership === undefined) return;
    const current = node.textContent ?? "";
    if (current !== ownership.translated) {
      this.#releaseTextOwnership(node);
      return;
    }
    const parent = node.parentElement;
    if (
      parent !== null &&
      this.#isConnectedToDocument(node) &&
      this.#isInScope(parent, ownership.scope) &&
      parent.closest(TEXT_PROTECTED_SURFACE_SELECTOR) === null
    ) {
      return;
    }
    node.textContent = ownership.original;
    this.#releaseTextOwnership(node);
  }

  #reconcileElementOwnership(element: Element): void {
    const attributes = this.#attributeOwnership.get(element);
    if (attributes === undefined) return;
    for (const attribute of [...attributes.keys()]) {
      this.#reconcileAttributeOwnership(element, attribute);
    }
  }

  #reconcileAttributeOwnership(element: Element, attribute: string): void {
    const attributes = this.#attributeOwnership.get(element);
    const ownership = attributes?.get(attribute);
    if (ownership === undefined) return;
    if (element.getAttribute(attribute) !== ownership.translated) {
      this.#releaseAttributeOwnership(element, attribute);
      return;
    }
    if (
      this.#isConnectedToDocument(element) &&
      this.#isInScope(element, ownership.scope) &&
      element.closest(ATTRIBUTE_PROTECTED_SURFACE_SELECTOR) === null
    ) {
      return;
    }
    if (ownership.wasPresent) {
      element.setAttribute(attribute, ownership.original ?? "");
    } else {
      element.removeAttribute(attribute);
    }
    this.#releaseAttributeOwnership(element, attribute);
  }

  #releaseTextOwnership(node: Node): void {
    this.#textOwnership.delete(node);
    this.#ownedTextNodes.delete(node);
  }

  #releaseAttributeOwnership(element: Element, attribute: string): void {
    const attributes = this.#attributeOwnership.get(element);
    if (attributes === undefined) return;
    attributes.delete(attribute);
    if (attributes.size !== 0) return;
    this.#attributeOwnership.delete(element);
    this.#ownedAttributeElements.delete(element);
  }

  #isConnectedToDocument(node: Node): boolean {
    return this.document.body?.contains(node) === true;
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
    this.#translateAttributesSafely(root, rules);
    for (const element of root.querySelectorAll("*")) {
      this.#translateAttributesSafely(element, rules);
    }

    const walker = this.document.createTreeWalker(root, 4);
    let node = walker.nextNode();
    while (node !== null) {
      try {
        this.#translateText(node, rules);
      } catch {
        this.#reportDescendantFailure(rules.scope);
      }
      node = walker.nextNode();
    }
  }

  #translateAttributesSafely(element: Element, rules: ScopeRules): void {
    try {
      this.#translateAttributes(element, rules);
    } catch {
      this.#reportDescendantFailure(rules.scope);
    }
  }

  #reportDescendantFailure(scope: string): void {
    this.#reportOnce(
      `descendant:${scope}`,
      "dom_translation_failed",
      `A DOM descendant in scope "${scope}" could not be translated.`,
    );
  }

  #translateText(node: Node, rules: ScopeRules): void {
    const value = node.textContent ?? "";
    let ownership = this.#textOwnership.get(node);
    if (ownership !== undefined && value === ownership.translated) return;
    const rule = rules.text.get(value.trim());
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
      ownership = { original: value, translated, scope: rules.scope };
      this.#textOwnership.set(node, ownership);
      this.#ownedTextNodes.add(node);
    } else {
      ownership.original = value;
      ownership.translated = translated;
      ownership.scope = rules.scope;
    }
    node.textContent = translated;
  }

  #translateAttributes(element: Element, rules: ScopeRules): void {
    if (
      rules.attributes.size === 0 ||
      element.closest(ATTRIBUTE_PROTECTED_SURFACE_SELECTOR) !== null
    ) {
      return;
    }
    for (const [attribute, attributeRules] of rules.attributes) {
      this.#translateAttribute(element, attribute, attributeRules, rules.scope);
    }
  }

  #translateAttribute(
    element: Element,
    attribute: string,
    rules: ReadonlyMap<string, DomTranslationRule>,
    scope: string,
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
        scope,
      };
      attributes.set(attribute, ownership);
    } else {
      ownership.wasPresent = element.hasAttribute(attribute);
      ownership.original = value;
      ownership.translated = rule.target;
      ownership.scope = scope;
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
