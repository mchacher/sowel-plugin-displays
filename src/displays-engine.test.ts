/**
 * Regression tests for displays-engine — specifically the
 * "newly observed orders trigger a re-upsert" path that used to
 * only log without persisting (bug fixed in v0.2.1).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DisplaysEngine, type DeviceManager, type Logger } from "./displays-engine.js";
import type { MqttConnector } from "./mqtt-connector.js";

function makeLogger(): Logger {
  const noop = () => {};
  const logger = {
    child: () => logger,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
  } as unknown as Logger;
  return logger;
}

function makeMqtt(): MqttConnector {
  return {
    subscribe: vi.fn(),
    publish: vi.fn(),
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
  } as unknown as MqttConnector;
}

function makeDeviceManager() {
  return {
    upsertFromDiscovery: vi.fn(),
    updateDeviceData: vi.fn(),
    updateDeviceStatus: vi.fn(),
  } satisfies DeviceManager;
}

// Reach into the private onState handler by re-binding through the
// mqtt.subscribe callback we capture from start().
function startEngineAndCapture(
  dm: ReturnType<typeof makeDeviceManager>,
  mqtt: MqttConnector,
  logger: Logger,
) {
  const subs = new Map<string, (topic: string, payload: Buffer) => void>();
  (mqtt.subscribe as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (pattern: string, cb: (topic: string, payload: Buffer) => void) => {
      subs.set(pattern, cb);
    },
  );
  const engine = new DisplaysEngine("displays", "sowel-display", mqtt, dm, logger);
  engine.start();
  return {
    fireState(id: string, body: Record<string, unknown>) {
      const cb = subs.get("sowel-display/+/state");
      if (!cb) throw new Error("state subscription not installed");
      cb(`sowel-display/${id}/state`, Buffer.from(JSON.stringify(body)));
    },
  };
}

describe("DisplaysEngine — order schema sync", () => {
  let dm: ReturnType<typeof makeDeviceManager>;
  let mqtt: MqttConnector;
  let logger: Logger;

  beforeEach(() => {
    dm = makeDeviceManager();
    mqtt = makeMqtt();
    logger = makeLogger();
  });

  it("first-time discovery upserts with the orders observed in the initial payload", () => {
    const { fireState } = startEngineAndCapture(dm, mqtt, logger);
    fireState("abc", {
      id: "sowel-display-abc",
      version: "1.2.0",
      uptime_s: 10,
      brightness: 80,
      language: "fr",
    });
    expect(dm.upsertFromDiscovery).toHaveBeenCalledTimes(1);
    const args = dm.upsertFromDiscovery.mock.calls[0];
    const discovered = args[2] as { orders: Array<{ key: string }> };
    const keys = discovered.orders.map((o) => o.key).sort();
    expect(keys).toEqual(["brightness", "language"]);
  });

  it("subsequent payload that adds a new order RE-upserts with the augmented schema", () => {
    const { fireState } = startEngineAndCapture(dm, mqtt, logger);
    // First state — no wake yet.
    fireState("abc", {
      id: "sowel-display-abc",
      version: "1.2.0",
      uptime_s: 10,
      brightness: 80,
      language: "fr",
    });
    expect(dm.upsertFromDiscovery).toHaveBeenCalledTimes(1);

    // Second state — firmware upgraded, now advertises `wake: true`.
    fireState("abc", {
      id: "sowel-display-abc",
      version: "1.3.0",
      uptime_s: 20,
      brightness: 80,
      language: "fr",
      wake: true,
    });

    // The bug being regressed: prior to v0.2.1 the second call was
    // missing entirely — the new `wake` order only ever lived in the
    // in-memory `declaredOrders` Set, never reaching Sowel's DB.
    expect(dm.upsertFromDiscovery).toHaveBeenCalledTimes(2);
    const secondArgs = dm.upsertFromDiscovery.mock.calls[1];
    const discovered = secondArgs[2] as { orders: Array<{ key: string; category: string }> };
    const keys = discovered.orders.map((o) => o.key).sort();
    expect(keys).toEqual(["brightness", "language", "wake"]);
    const wakeOrder = discovered.orders.find((o) => o.key === "wake");
    expect(wakeOrder?.category).toBe("display_wake");
  });

  it("repeated identical payloads do NOT trigger spurious re-upserts", () => {
    const { fireState } = startEngineAndCapture(dm, mqtt, logger);
    const body = {
      id: "sowel-display-abc",
      version: "1.3.0",
      uptime_s: 10,
      brightness: 80,
      language: "fr",
      wake: true,
    };
    fireState("abc", body);
    fireState("abc", { ...body, uptime_s: 20 });
    fireState("abc", { ...body, uptime_s: 30, brightness: 50 });
    // Only the first call upserts the schema. Subsequent calls only
    // push values via updateDeviceData.
    expect(dm.upsertFromDiscovery).toHaveBeenCalledTimes(1);
    expect(dm.updateDeviceData).toHaveBeenCalledTimes(3);
  });
});
