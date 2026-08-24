export type LocaleTranslateArguments = [
  namespace: string,
  key: string,
  params?: Record<string, unknown>,
];

export type LocaleTranslate = (...args: LocaleTranslateArguments) => unknown;

export type AdapterResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false };

export type LocaleInstallResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly runtimeMayBePatched: boolean };

export interface DshLocaleRuntimeAdapter {
  readonly runtime: object;
  getActiveLocale(): AdapterResult<string>;
  callOriginal(args: LocaleTranslateArguments): unknown;
  install(wrapper: LocaleTranslate): LocaleInstallResult;
  restoreOriginalIfCurrent(
    wrapper: LocaleTranslate,
  ): AdapterResult<"restored" | "replaced">;
}

function failure<T>(): AdapterResult<T> {
  return { ok: false };
}

export function adaptDshLocaleRuntime(
  value: unknown,
): DshLocaleRuntimeAdapter | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  let translate: unknown;
  let getSnapshot: unknown;
  let subscribe: unknown;
  let originalTranslateDescriptor: PropertyDescriptor | undefined;
  try {
    translate = Reflect.get(value, "translate");
    getSnapshot = Reflect.get(value, "getSnapshot");
    subscribe = Reflect.get(value, "subscribe");
    originalTranslateDescriptor = Reflect.getOwnPropertyDescriptor(
      value,
      "translate",
    );
  } catch {
    return undefined;
  }
  if (
    typeof translate !== "function" ||
    typeof getSnapshot !== "function" ||
    typeof subscribe !== "function"
  ) {
    return undefined;
  }

  const runtime = value;
  const originalTranslate = translate;
  const capturedGetSnapshot = getSnapshot;

  function restoreOriginalTranslate(): boolean {
    try {
      if (originalTranslateDescriptor === undefined) {
        if (!Reflect.deleteProperty(runtime, "translate")) return false;
      } else if ("value" in originalTranslateDescriptor) {
        if (
          !Reflect.defineProperty(
            runtime,
            "translate",
            originalTranslateDescriptor,
          )
        ) {
          return false;
        }
      } else {
        if (!Reflect.set(runtime, "translate", originalTranslate)) return false;
        if (
          !Reflect.defineProperty(
            runtime,
            "translate",
            originalTranslateDescriptor,
          )
        ) {
          return false;
        }
      }
      return Reflect.get(runtime, "translate") === originalTranslate;
    } catch {
      return false;
    }
  }

  return {
    runtime,
    getActiveLocale(): AdapterResult<string> {
      try {
        const snapshot = Reflect.apply(capturedGetSnapshot, runtime, []);
        if (typeof snapshot !== "object" || snapshot === null) return failure();
        const active = Reflect.get(snapshot, "active");
        return typeof active === "string"
          ? { ok: true, value: active }
          : failure();
      } catch {
        return failure();
      }
    },
    callOriginal(args): unknown {
      return Reflect.apply(originalTranslate, runtime, args);
    },
    install(wrapper): LocaleInstallResult {
      const failedInstall = (): LocaleInstallResult => ({
        ok: false,
        runtimeMayBePatched: !restoreOriginalTranslate(),
      });
      try {
        if (!Reflect.set(runtime, "translate", wrapper)) {
          return failedInstall();
        }
        if (Reflect.get(runtime, "translate") !== wrapper) {
          return failedInstall();
        }
        return { ok: true };
      } catch {
        return failedInstall();
      }
    },
    restoreOriginalIfCurrent(wrapper): AdapterResult<"restored" | "replaced"> {
      try {
        if (Reflect.get(runtime, "translate") !== wrapper) {
          return { ok: true, value: "replaced" };
        }
        if (!restoreOriginalTranslate()) return failure();
        return { ok: true, value: "restored" };
      } catch {
        return failure();
      }
    },
  };
}
