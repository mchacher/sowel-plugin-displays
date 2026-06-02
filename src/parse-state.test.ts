import { describe, it, expect } from "vitest";
import { parseState } from "./parse-state.js";

describe("parseState", () => {
  it("parses a full payload — every canonical field becomes a data row", () => {
    const body = JSON.stringify({
      id: "sowel-display-9a3b1c",
      hostname: "sowel-display-9a3b1c",
      version: "1.2.1",
      uptime_s: 12345,
      ip: "192.168.0.123",
      rssi: -55,
      language: "fr",
      brightness: 80,
    });
    const r = parseState(body);
    expect(r).not.toBeNull();
    expect(r!.id).toBe("sowel-display-9a3b1c");
    expect(r!.hostname).toBe("sowel-display-9a3b1c");
    const keys = r!.data.map((d) => d.key);
    expect(keys).toEqual([
      "firmware_version",
      "uptime",
      "hostname",
      "ip_address",
      "rssi",
      "language",
      "brightness",
    ]);
    const orderCats = r!.orders.map((o) => o.category);
    expect(orderCats).toEqual(["set_language", "set_display_brightness"]);
  });

  it("mandatory-only payload — only firmware_version + uptime, no orders", () => {
    const body = JSON.stringify({ id: "x", version: "0.1.0", uptime_s: 5 });
    const r = parseState(body);
    expect(r).not.toBeNull();
    expect(r!.data.map((d) => d.key)).toEqual(["firmware_version", "uptime"]);
    expect(r!.orders).toEqual([]);
  });

  it("missing recommended fields — degrades gracefully, no throw", () => {
    const body = JSON.stringify({ id: "x", version: "0.1.0", uptime_s: 5, brightness: 50 });
    const r = parseState(body);
    expect(r!.data.find((d) => d.key === "brightness")?.value).toBe(50);
    expect(r!.data.find((d) => d.key === "rssi")).toBeUndefined();
    expect(r!.orders.map((o) => o.category)).toEqual(["set_display_brightness"]);
  });

  it("unknown extras — passed through as generic data", () => {
    const body = JSON.stringify({
      id: "x",
      version: "0.1.0",
      uptime_s: 5,
      battery_pct: 78,
      sleep_s: 900,
      custom_flag: true,
    });
    const r = parseState(body);
    const generic = r!.data.filter((d) => d.category === "generic");
    expect(generic.map((d) => d.key).sort()).toEqual([
      "battery_pct",
      "custom_flag",
      "sleep_s",
    ]);
  });

  it("malformed JSON → null", () => {
    expect(parseState("{ not json")).toBeNull();
  });

  it("non-object JSON (array, primitive) → null", () => {
    expect(parseState("[1, 2, 3]")).toBeNull();
    expect(parseState("42")).toBeNull();
    expect(parseState('"a string"')).toBeNull();
  });

  it("brightness out of range → clamped to 0..100", () => {
    const r1 = parseState(JSON.stringify({ id: "x", version: "v", uptime_s: 1, brightness: 250 }))!;
    expect(r1.data.find((d) => d.key === "brightness")?.value).toBe(100);
    const r2 = parseState(JSON.stringify({ id: "x", version: "v", uptime_s: 1, brightness: -10 }))!;
    expect(r2.data.find((d) => d.key === "brightness")?.value).toBe(0);
  });

  it("missing id → returned as null (caller will drop the message)", () => {
    const r = parseState(JSON.stringify({ version: "v", uptime_s: 1 }));
    expect(r).not.toBeNull();
    expect(r!.id).toBeNull();
  });

  it("hostname falls back to null when absent — caller uses id as Device.name", () => {
    const r = parseState(JSON.stringify({ id: "x", version: "v", uptime_s: 1 }));
    expect(r!.hostname).toBeNull();
  });

  it("wrong types on canonical fields are silently dropped", () => {
    const body = JSON.stringify({
      id: "x",
      version: 123, // wrong: should be string
      uptime_s: "abc", // wrong: should be number
      rssi: null,
      language: 0,
      brightness: "high",
    });
    const r = parseState(body);
    expect(r!.data).toEqual([]);
    expect(r!.orders).toEqual([]);
  });

  it("wake: true advertises the display_wake order (spec 122)", () => {
    const r = parseState(
      JSON.stringify({ id: "x", version: "v", uptime_s: 1, wake: true }),
    )!;
    const wakeOrder = r.orders.find((o) => o.category === "display_wake");
    expect(wakeOrder).toEqual({
      key: "wake",
      type: "boolean",
      category: "display_wake",
    });
    // wake is a capability flag, not telemetry — no data row.
    expect(r.data.find((d) => d.key === "wake")).toBeUndefined();
  });

  it("wake absent → no display_wake order, no generic data row", () => {
    const r = parseState(JSON.stringify({ id: "x", version: "v", uptime_s: 1 }))!;
    expect(r.orders.find((o) => o.category === "display_wake")).toBeUndefined();
    expect(r.data.find((d) => d.key === "wake")).toBeUndefined();
  });

  it("wake: false → no display_wake order (firmware opts out)", () => {
    const r = parseState(
      JSON.stringify({ id: "x", version: "v", uptime_s: 1, wake: false }),
    )!;
    expect(r.orders.find((o) => o.category === "display_wake")).toBeUndefined();
    expect(r.data.find((d) => d.key === "wake")).toBeUndefined();
  });
});
