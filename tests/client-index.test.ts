import { describe, expect, it } from "vitest";
import { apply, inject } from "../src/client/index.js";

describe("client entrypoint", () => {
  it("declares only the locale runtime dependency", () => {
    expect(inject).toEqual(["locale"]);
    expect(typeof apply).toBe("function");
  });
});
