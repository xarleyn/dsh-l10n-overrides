import { Diagnostics } from "./diagnostics.js";
import type { DomTranslationRule, TranslationPack } from "../types.js";

const DOM_TRANSLATION_ATTRIBUTES = new Set([
  "placeholder",
  "title",
  "aria-label",
  "alt",
]);
const EMPTY_DOM_RULES: readonly DomTranslationRule[] = Object.freeze([]);

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUsableDomRule(value: unknown): value is DomTranslationRule {
  if (typeof value !== "object" || value === null) return false;

  const rule = value as Record<string, unknown>;
  return (
    isNonBlankString(rule.source) &&
    isNonBlankString(rule.target) &&
    isNonBlankString(rule.scope) &&
    (rule.mode === undefined || rule.mode === "exact") &&
    (rule.attributes === undefined ||
      (Array.isArray(rule.attributes) &&
        rule.attributes.every(
          (attribute) =>
            typeof attribute === "string" &&
            DOM_TRANSLATION_ATTRIBUTES.has(attribute),
        )))
  );
}

function snapshotDomRule(rule: DomTranslationRule): DomTranslationRule {
  const attributes =
    rule.attributes === undefined
      ? undefined
      : Object.freeze([...rule.attributes]);
  return Object.freeze({
    source: rule.source,
    target: rule.target,
    scope: rule.scope,
    ...(rule.mode === undefined ? {} : { mode: rule.mode }),
    ...(attributes === undefined ? {} : { attributes }),
  });
}

export interface TranslationRegistryEntry {
  readonly value: string;
  readonly packId: string;
}

export interface TranslationRegistryStats {
  readonly packs: number;
  readonly localeOverrides: number;
  readonly domRules: number;
}

export class TranslationPackRegistry {
  readonly #translations = new Map<
    string,
    Map<string, Map<string, TranslationRegistryEntry>>
  >();
  readonly #packIds = new Set<string>();
  readonly #domRules: DomTranslationRule[] = [];
  #packCount = 0;
  #overrideCount = 0;

  constructor(private readonly diagnostics: Diagnostics) {}

  register(pack: TranslationPack): void {
    if (this.#packIds.has(pack.id)) {
      this.diagnostics.error(
        "duplicate_pack_id",
        `Duplicate pack id "${pack.id}" ignored.`,
      );
      return;
    }

    this.#packIds.add(pack.id);
    this.#packCount += 1;
    let namespaces = this.#translations.get("en");
    if (namespaces === undefined) {
      namespaces = new Map();
      this.#translations.set("en", namespaces);
    }

    for (const [namespace, dictionary] of Object.entries(pack.en)) {
      let entries = namespaces.get(namespace);
      if (entries === undefined) {
        entries = new Map();
        namespaces.set(namespace, entries);
      }

      for (const [key, value] of Object.entries(dictionary)) {
        const previous = entries.get(key);
        if (previous !== undefined) {
          this.diagnostics.error(
            "duplicate_override",
            `Duplicate override en/${namespace}/${key}: keeping pack "${previous.packId}"; ignoring pack "${pack.id}".`,
          );
          continue;
        }

        entries.set(key, Object.freeze({ value, packId: pack.id }));
        this.#overrideCount += 1;
      }
    }

    if (pack.dom !== undefined) {
      const rules: readonly unknown[] = Array.isArray(pack.dom) ? pack.dom : [];
      if (
        rules.some(
          (rule) =>
            typeof rule === "object" &&
            rule !== null &&
            (rule as Record<string, unknown>).scope === "global",
        )
      ) {
        this.diagnostics.warning(
          "global_dom_scope",
          `Pack "${pack.id}" contains global DOM translation rules.`,
        );
      }
      for (const [index, rule] of rules.entries()) {
        if (!isUsableDomRule(rule)) {
          this.diagnostics.error(
            "invalid_dom_rule",
            `Pack "${pack.id}" DOM rule at index ${index} is invalid and was ignored.`,
          );
          continue;
        }
        this.#domRules.push(snapshotDomRule(rule));
      }
    }
  }

  resolve(locale: string, namespace: string, key: string): string | undefined {
    return this.resolveEntry(locale, namespace, key)?.value;
  }

  resolveEntry(
    locale: string,
    namespace: string,
    key: string,
  ): TranslationRegistryEntry | undefined {
    return this.#translations.get(locale)?.get(namespace)?.get(key);
  }

  getStats(): TranslationRegistryStats {
    return Object.freeze({
      packs: this.#packCount,
      localeOverrides: this.#overrideCount,
      domRules: this.#domRules.length,
    });
  }

  getDomRules(locale: string): readonly DomTranslationRule[] {
    return locale === "en"
      ? Object.freeze(this.#domRules.slice())
      : EMPTY_DOM_RULES;
  }
}
