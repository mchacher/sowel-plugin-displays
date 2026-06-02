import { describe, it, expect } from "vitest";
import { dispatchOrder } from "./dispatch-order.js";

describe("dispatchOrder", () => {
  it("brightness with valid 0..100 → cmd/brightness with integer string", () => {
    const r = dispatchOrder("sowel-display", "abc", "brightness", 80);
    expect(r).toEqual({ topic: "sowel-display/abc/cmd/brightness", payload: "80" });
  });

  it("brightness clamps high values to 100", () => {
    const r = dispatchOrder("sowel-display", "abc", "brightness", 250);
    expect(r?.payload).toBe("100");
  });

  it("brightness clamps low values to 0", () => {
    const r = dispatchOrder("sowel-display", "abc", "brightness", -10);
    expect(r?.payload).toBe("0");
  });

  it("brightness rounds floats to integer", () => {
    const r = dispatchOrder("sowel-display", "abc", "brightness", 49.6);
    expect(r?.payload).toBe("50");
  });

  it("brightness with non-numeric → null", () => {
    expect(dispatchOrder("sowel-display", "abc", "brightness", "high")).toBeNull();
    expect(dispatchOrder("sowel-display", "abc", "brightness", null)).toBeNull();
  });

  it("language with a non-empty string → cmd/language", () => {
    const r = dispatchOrder("sowel-display", "abc", "language", "en");
    expect(r).toEqual({ topic: "sowel-display/abc/cmd/language", payload: "en" });
  });

  it("language with empty string or wrong type → null", () => {
    expect(dispatchOrder("sowel-display", "abc", "language", "")).toBeNull();
    expect(dispatchOrder("sowel-display", "abc", "language", 42)).toBeNull();
  });

  it("vendor-specific order — passthrough as String(value)", () => {
    const r = dispatchOrder("sowel-display", "abc", "refresh_now", true);
    expect(r).toEqual({ topic: "sowel-display/abc/cmd/refresh_now", payload: "true" });
  });

  it("vendor-specific order with null/undefined → null", () => {
    expect(dispatchOrder("sowel-display", "abc", "refresh_now", null)).toBeNull();
    expect(dispatchOrder("sowel-display", "abc", "refresh_now", undefined)).toBeNull();
  });

  it("topic prefix is respected (custom value)", () => {
    const r = dispatchOrder("my-displays", "xyz", "language", "fr");
    expect(r?.topic).toBe("my-displays/xyz/cmd/language");
  });

  it("wake → cmd/wake with empty payload, value ignored (spec 122)", () => {
    const r = dispatchOrder("sowel-display", "abc", "wake", null);
    expect(r).toEqual({ topic: "sowel-display/abc/cmd/wake", payload: "" });
  });

  it("wake with any value still produces empty payload", () => {
    const r1 = dispatchOrder("sowel-display", "abc", "wake", true);
    const r2 = dispatchOrder("sowel-display", "abc", "wake", 42);
    const r3 = dispatchOrder("sowel-display", "abc", "wake", "anything");
    expect(r1?.payload).toBe("");
    expect(r2?.payload).toBe("");
    expect(r3?.payload).toBe("");
  });
});
