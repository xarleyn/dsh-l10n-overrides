import { describe, expect, it, vi } from "vitest";
import { Diagnostics } from "../src/registry/diagnostics.js";
import { TranslationPackRegistry } from "../src/registry/translation-registry.js";
import type { TranslationPack } from "../src/types.js";

function createDiagnostics(): Diagnostics {
  return new Diagnostics({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  });
}

describe("TranslationPackRegistry", () => {
  it("resolves registered English translations by exact locale, namespace, and key", () => {
    const registry = new TranslationPackRegistry(createDiagnostics());
    const pack = {
      id: "core",
      target: { package: "example" },
      en: { composer: { send: "Send" } },
    } as const satisfies TranslationPack;

    registry.register(pack);

    expect(registry.resolve("en", "composer", "send")).toBe("Send");
    expect(registry.resolve("EN", "composer", "send")).toBeUndefined();
    expect(registry.resolve("en", "Composer", "send")).toBeUndefined();
    expect(registry.resolve("en", "composer", "Send")).toBeUndefined();
    expect(registry.resolve("fr", "composer", "send")).toBeUndefined();
  });

  it("reports the owning pack for an exact translation hit", () => {
    const registry = new TranslationPackRegistry(createDiagnostics());
    registry.register({
      id: "composer-pack",
      target: { package: "example" },
      en: { composer: { send: "Send" } },
    });

    expect(registry.resolveEntry("en", "composer", "send")).toEqual({
      value: "Send",
      packId: "composer-pack",
    });
    expect(registry.resolveEntry("en", "composer", "missing")).toBeUndefined();
  });

  it("indexes and counts nonconflicting packs, namespaces, and keys", () => {
    const registry = new TranslationPackRegistry(createDiagnostics());
    registry.register({
      id: "first",
      target: { package: "first-package" },
      en: {
        composer: { send: "Send", cancel: "Cancel" },
        history: { clear: "Clear history" },
      },
    });
    registry.register({
      id: "second",
      target: { package: "second-package" },
      en: { settings: { save: "Save" } },
    });

    expect(registry.resolve("en", "composer", "send")).toBe("Send");
    expect(registry.resolve("en", "composer", "cancel")).toBe("Cancel");
    expect(registry.resolve("en", "history", "clear")).toBe("Clear history");
    expect(registry.resolve("en", "settings", "save")).toBe("Save");
    expect(registry.getStats()).toEqual({
      packs: 2,
      localeOverrides: 4,
      domRules: 0,
    });
  });

  it("keeps the first exact override and diagnoses later collisions", () => {
    const diagnostics = createDiagnostics();
    const registry = new TranslationPackRegistry(diagnostics);
    registry.register({
      id: "first-pack",
      target: { package: "first-package" },
      en: { composer: { send: "Send first" } },
    });
    registry.register({
      id: "second-pack",
      target: { package: "second-package" },
      en: { composer: { send: "Send second" } },
    });

    expect(registry.resolveEntry("en", "composer", "send")).toEqual({
      value: "Send first",
      packId: "first-pack",
    });
    expect(registry.getStats()).toEqual({
      packs: 2,
      localeOverrides: 1,
      domRules: 0,
    });
    expect(diagnostics.snapshot()).toHaveLength(1);
    expect(diagnostics.snapshot()[0]).toMatchObject({
      level: "error",
      code: "duplicate_override",
    });
    for (const detail of [
      "en",
      "composer",
      "send",
      "first-pack",
      "second-pack",
    ]) {
      expect(diagnostics.snapshot()[0]?.message).toContain(detail);
    }
  });

  it("diagnoses duplicate pack ids and ignores the entire later pack", () => {
    const diagnostics = createDiagnostics();
    const registry = new TranslationPackRegistry(diagnostics);
    registry.register({
      id: "same-id",
      target: { package: "first-package" },
      en: { first: { key: "First" } },
      dom: [{ source: "Uno", target: "One", scope: ".first" }],
    });
    registry.register({
      id: "same-id",
      target: { package: "second-package" },
      en: { second: { key: "Second" } },
      dom: [{ source: "Dos", target: "Two", scope: "global" }],
    });

    expect(registry.resolve("en", "first", "key")).toBe("First");
    expect(registry.resolve("en", "second", "key")).toBeUndefined();
    expect(registry.getDomRules("en")).toEqual([
      { source: "Uno", target: "One", scope: ".first" },
    ]);
    expect(registry.getStats()).toEqual({
      packs: 1,
      localeOverrides: 1,
      domRules: 1,
    });
    expect(diagnostics.snapshot()).toEqual([
      {
        level: "error",
        code: "duplicate_pack_id",
        message: expect.stringContaining("same-id"),
      },
    ]);
  });

  it("returns English DOM rules in registration order and no rules for other locales", () => {
    const registry = new TranslationPackRegistry(createDiagnostics());
    registry.register({
      id: "first",
      target: { package: "first-package" },
      en: {},
      dom: [
        {
          source: "Enviar",
          target: "Send",
          scope: ".composer",
          mode: "exact",
          attributes: ["title"],
        },
        { source: "Cancelar", target: "Cancel", scope: ".composer" },
      ],
    });
    registry.register({
      id: "second",
      target: { package: "second-package" },
      en: {},
      dom: [{ source: "Guardar", target: "Save", scope: ".settings" }],
    });

    expect(registry.getDomRules("en")).toEqual([
      {
        source: "Enviar",
        target: "Send",
        scope: ".composer",
        mode: "exact",
        attributes: ["title"],
      },
      { source: "Cancelar", target: "Cancel", scope: ".composer" },
      { source: "Guardar", target: "Save", scope: ".settings" },
    ]);
    expect(registry.getDomRules("EN")).toEqual([]);
    expect(registry.getDomRules("fr")).toEqual([]);
    expect(registry.getStats()).toEqual({
      packs: 2,
      localeOverrides: 0,
      domRules: 3,
    });
  });

  it("warns exactly once per pack containing global DOM rules", () => {
    const diagnostics = createDiagnostics();
    const registry = new TranslationPackRegistry(diagnostics);
    registry.register({
      id: "global-pack",
      target: { package: "example" },
      en: {},
      dom: [
        { source: "Uno", target: "One", scope: "global" },
        { source: "Dos", target: "Two", scope: ".scoped" },
        { source: "Tres", target: "Three", scope: "global" },
      ],
    });

    expect(registry.getDomRules("en")).toHaveLength(3);
    expect(diagnostics.snapshot()).toEqual([
      {
        level: "warning",
        code: "global_dom_scope",
        message: expect.stringContaining("global-pack"),
      },
    ]);
  });

  it("skips malformed runtime DOM rules while keeping valid siblings", () => {
    const diagnostics = createDiagnostics();
    const registry = new TranslationPackRegistry(diagnostics);
    const pack = {
      id: "runtime-pack",
      target: { package: "example" },
      en: {},
      dom: [
        { source: "Valid", target: "Good", scope: "[broken-selector" },
        { source: "Blank scope", target: "Bad", scope: "   " },
        { source: " ", target: "Bad", scope: ".scope" },
        { source: "Blank target", target: "\t", scope: ".scope" },
        {
          source: "Unsupported mode",
          target: "Bad",
          scope: ".scope",
          mode: "contains",
        },
        {
          source: "Unsupported attribute",
          target: "Bad",
          scope: ".scope",
          attributes: ["title", "value"],
        },
      ],
    } as unknown as TranslationPack;

    expect(() => registry.register(pack)).not.toThrow();
    expect(registry.getDomRules("en")).toEqual([
      { source: "Valid", target: "Good", scope: "[broken-selector" },
    ]);
    expect(registry.getStats()).toEqual({
      packs: 1,
      localeOverrides: 0,
      domRules: 1,
    });
    expect(diagnostics.snapshot()).toHaveLength(5);
    expect(
      diagnostics
        .snapshot()
        .every(
          ({ level, code, message }) =>
            level === "error" &&
            code === "invalid_dom_rule" &&
            message.includes("runtime-pack"),
        ),
    ).toBe(true);
  });

  it("snapshots translation and DOM source data at registration", () => {
    const registry = new TranslationPackRegistry(createDiagnostics());
    const source = {
      id: "mutable-pack",
      target: { package: "example" },
      en: { composer: { send: "Send" } },
      dom: [
        {
          source: "Enviar",
          target: "Send",
          scope: ".composer",
          mode: "exact",
          attributes: ["title"],
        },
      ],
    };
    registry.register(source as unknown as TranslationPack);

    source.id = "changed-pack";
    source.en.composer.send = "Changed";
    Object.assign(source.en.composer, { cancel: "Cancel" });
    source.dom[0]!.source = "Changed";
    source.dom[0]!.attributes.push("alt");
    source.dom.push({
      source: "Cancelar",
      target: "Cancel",
      scope: ".composer",
      mode: "exact",
      attributes: ["title"],
    });

    expect(registry.resolveEntry("en", "composer", "send")).toEqual({
      value: "Send",
      packId: "mutable-pack",
    });
    expect(registry.resolve("en", "composer", "cancel")).toBeUndefined();
    expect(registry.getDomRules("en")).toEqual([
      {
        source: "Enviar",
        target: "Send",
        scope: ".composer",
        mode: "exact",
        attributes: ["title"],
      },
    ]);
  });

  it("counts empty packs and returns frozen stats snapshots", () => {
    const registry = new TranslationPackRegistry(createDiagnostics());
    registry.register({
      id: "empty-pack",
      target: { package: "example" },
      en: {},
      dom: [],
    });

    const stats = registry.getStats();
    expect(stats).toEqual({ packs: 1, localeOverrides: 0, domRules: 0 });
    expect(Object.isFrozen(stats)).toBe(true);
    expect(() => {
      (stats as { packs: number }).packs = 99;
    }).toThrow();
    expect(registry.getStats()).toEqual({
      packs: 1,
      localeOverrides: 0,
      domRules: 0,
    });
  });

  it("does not expose mutable translation entry internals", () => {
    const registry = new TranslationPackRegistry(createDiagnostics());
    registry.register({
      id: "immutable-pack",
      target: { package: "example" },
      en: { composer: { send: "Send" } },
    });

    const entry = registry.resolveEntry("en", "composer", "send");
    expect(entry).toEqual({ value: "Send", packId: "immutable-pack" });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as { value: string }).value = "Changed";
    }).toThrow();
    expect(registry.resolveEntry("en", "composer", "send")).toEqual({
      value: "Send",
      packId: "immutable-pack",
    });
  });

  it("returns deeply frozen DOM rule snapshots without exposing the registry array", () => {
    const registry = new TranslationPackRegistry(createDiagnostics());
    registry.register({
      id: "dom-pack",
      target: { package: "example" },
      en: {},
      dom: [
        {
          source: "Enviar",
          target: "Send",
          scope: ".composer",
          attributes: ["title"],
        },
      ],
    });

    const rules = registry.getDomRules("en");
    expect(Object.isFrozen(rules)).toBe(true);
    expect(Object.isFrozen(rules[0])).toBe(true);
    expect(Object.isFrozen(rules[0]?.attributes)).toBe(true);
    expect(Object.isFrozen(registry.getDomRules("fr"))).toBe(true);
    expect(() => {
      (rules as unknown[]).push({});
    }).toThrow();
    expect(() => {
      (rules[0] as { source: string }).source = "Changed";
    }).toThrow();
    expect(() => {
      (rules[0]?.attributes as string[]).push("alt");
    }).toThrow();
    expect(registry.getDomRules("en")).toEqual([
      {
        source: "Enviar",
        target: "Send",
        scope: ".composer",
        attributes: ["title"],
      },
    ]);
  });
});
