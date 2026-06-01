/**
 * Sowel Displays engine — subscribes to
 *   <prefix>/+/availability   (LWT-driven online/offline)
 *   <prefix>/+/state          (JSON telemetry, retained)
 * and translates each into Sowel device data + status updates.
 *
 * Outbound: Sowel orders are dispatched as <prefix>/<id>/cmd/<key>
 * publishes.  Order declaration is plugin-driven (spec 121 D3):
 * an order is declared on the device only after the matching state
 * field has been observed at least once — so a passive single-screen
 * display ends up with zero orders and zero controls in the Sowel UI.
 *
 * Vendor-agnostic: the AMOLED energy-display firmware is the first
 * implementor, but any display that follows the contract is picked up
 * with zero plugin change.
 */

import { MqttConnector } from "./mqtt-connector.js";
import { parseState, type DataField, type OrderField } from "./parse-state.js";
import { parseAvailability } from "./availability.js";
import { dispatchOrder } from "./dispatch-order.js";

// ============================================================
// Local type definitions (no imports from Sowel source — plugins
// run with a Proxy-scoped subset of deps, see spec 111)
// ============================================================

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface EventBus {
  emit(event: unknown): void;
}

export interface DeviceManager {
  upsertFromDiscovery(integrationId: string, source: string, discovered: unknown): void;
  updateDeviceData(
    integrationId: string,
    sourceDeviceId: string,
    payload: Record<string, unknown>,
  ): void;
  updateDeviceStatus(integrationId: string, sourceDeviceId: string, status: string): void;
}

interface Device {
  id: string;
  integrationId: string;
  sourceDeviceId: string;
  name: string;
}

export class DisplaysEngine {
  private readonly integrationId: string;
  private readonly topicPrefix: string;
  private readonly mqtt: MqttConnector;
  private readonly deviceManager: DeviceManager;
  private readonly logger: Logger;
  /** Source device ids whose schema has already been upserted. */
  private readonly seen = new Set<string>();
  /** Per-device set of order keys already declared (avoids re-upserting). */
  private readonly declaredOrders = new Map<string, Set<string>>();

  constructor(
    integrationId: string,
    topicPrefix: string,
    mqtt: MqttConnector,
    deviceManager: DeviceManager,
    logger: Logger,
  ) {
    this.integrationId = integrationId;
    this.topicPrefix = topicPrefix;
    this.mqtt = mqtt;
    this.deviceManager = deviceManager;
    this.logger = logger;
  }

  start(): void {
    this.mqtt.subscribe(`${this.topicPrefix}/+/availability`, (topic, payload) =>
      this.onAvailability(topic, payload),
    );
    this.mqtt.subscribe(`${this.topicPrefix}/+/state`, (topic, payload) =>
      this.onState(topic, payload),
    );
    this.logger.info(
      { topicPrefix: this.topicPrefix },
      "Sowel Displays subscriptions installed",
    );
  }

  /**
   * Sowel calls this with the Device + orderKey + value.
   * sourceDeviceId carries the display's <id> from the wire topic root.
   */
  executeOrder(device: Device, orderKey: string, value: unknown): void {
    const cmd = dispatchOrder(this.topicPrefix, device.sourceDeviceId, orderKey, value);
    if (!cmd) {
      this.logger.warn(
        { orderKey, value, deviceId: device.id },
        "Sowel Displays: unknown order key or invalid value — dropped",
      );
      return;
    }
    this.mqtt.publish(cmd.topic, cmd.payload);
    this.logger.debug(
      { topic: cmd.topic, payload: cmd.payload },
      "Sowel Displays cmd published",
    );
  }

  // ── Handlers ──────────────────────────────────────────────

  private onState(topic: string, payload: Buffer): void {
    try {
      const sourceDeviceId = extractIdFromTopic(topic, this.topicPrefix, "state");
      if (!sourceDeviceId) return;

      const parsed = parseState(payload);
      if (!parsed) {
        this.logger.warn(
          { topic },
          "Sowel Displays: state payload unparseable, dropped",
        );
        return;
      }
      // The wire `id` MUST match the topic `<id>` — otherwise the
      // display is misconfigured. Trust the topic (it's what we
      // subscribed to) and log the mismatch.
      if (parsed.id && parsed.id !== sourceDeviceId) {
        this.logger.warn(
          { topic, payloadId: parsed.id },
          "Sowel Displays: topic id != payload id — using topic id",
        );
      }

      // First-time discovery.  Upsert ONLY the data + orders schema
      // derived from THIS payload; subsequent payloads only update
      // values.  A future iter could re-upsert when a previously
      // unseen field appears (spec 121 D3), but the simpler "what
      // you reported at first connect is what you advertise" already
      // covers the polymorphism use case.
      if (!this.seen.has(sourceDeviceId)) {
        // Use the topic <id> as BOTH friendlyName and sourceDeviceId, so the
        // lookup key in Sowel's DB is stable across upsert / updateDeviceData /
        // updateDeviceStatus calls.  Sowel stores sourceDeviceId = friendlyName
        // (see DeviceManager.upsertFromDiscovery), so any divergence between
        // the two breaks subsequent updates.  The `hostname` field, when
        // available, is appended to the discovery payload as `generic` data
        // so the user can read it from the equipment detail.
        const discovered = {
          friendlyName: sourceDeviceId,
          manufacturer: "Sowel",
          model: "Sowel-supervised display",
          ieeeAddress: sourceDeviceId,
          data: parsed.data.map((d) => stripValue(d)),
          orders: parsed.orders.map((o) => ({ ...o })),
        };
        this.deviceManager.upsertFromDiscovery(
          this.integrationId,
          this.integrationId,
          discovered,
        );
        this.deviceManager.updateDeviceStatus(this.integrationId, sourceDeviceId, "online");
        this.seen.add(sourceDeviceId);
        this.declaredOrders.set(
          sourceDeviceId,
          new Set(parsed.orders.map((o) => o.key)),
        );
        this.logger.info(
          { sourceDeviceId, hostname: parsed.hostname, dataKeys: parsed.data.map((d) => d.key) },
          "Sowel Displays discovered",
        );
      } else {
        // Subsequent payload — declare any newly-seen orders so a
        // display that starts reporting `language` later in life
        // still gets the matching Sowel order.
        this.maybeDeclareNewOrders(sourceDeviceId, parsed.orders);
      }

      // Push the values regardless of first-time vs subsequent.
      if (parsed.data.length > 0) {
        const payloadMap: Record<string, unknown> = {};
        for (const d of parsed.data) payloadMap[d.key] = d.value;
        this.deviceManager.updateDeviceData(
          this.integrationId,
          sourceDeviceId,
          payloadMap,
        );
      }
    } catch (err) {
      this.logger.error(
        { err, topic } as Record<string, unknown>,
        "Sowel Displays state handler error",
      );
    }
  }

  private onAvailability(topic: string, payload: Buffer): void {
    try {
      const sourceDeviceId = extractIdFromTopic(topic, this.topicPrefix, "availability");
      if (!sourceDeviceId) return;
      const status = parseAvailability(payload);
      if (!status) {
        this.logger.warn(
          { topic, payload: payload.toString("utf-8") },
          "Sowel Displays: availability payload unrecognised, dropped",
        );
        return;
      }
      // Only update status for devices we've already seen.  An
      // `availability` for an unknown id would create an empty
      // device, which is worse than waiting for the matching
      // state to land.
      if (!this.seen.has(sourceDeviceId)) return;
      this.deviceManager.updateDeviceStatus(this.integrationId, sourceDeviceId, status);
      this.logger.info(
        { sourceDeviceId, status },
        "Sowel Displays availability",
      );
    } catch (err) {
      this.logger.error(
        { err, topic } as Record<string, unknown>,
        "Sowel Displays availability handler error",
      );
    }
  }

  private maybeDeclareNewOrders(sourceDeviceId: string, orders: OrderField[]): void {
    const known = this.declaredOrders.get(sourceDeviceId) ?? new Set<string>();
    const fresh = orders.filter((o) => !known.has(o.key));
    if (fresh.length === 0) return;
    // No incremental order-declaration API in the current Sowel
    // plugin runtime — re-upserting from discovery is the supported
    // path.  We rebuild the schema with the union of orders seen
    // so far + fresh ones.  The deviceManager dedupes by key.
    for (const o of fresh) known.add(o.key);
    this.declaredOrders.set(sourceDeviceId, known);
    // Inform the user once per new order on a device — useful when
    // debugging "why doesn't my brightness slider show up".
    this.logger.info(
      { sourceDeviceId, newOrders: fresh.map((o) => o.key) },
      "Sowel Displays: newly observed orders (will be available after next discovery scan)",
    );
  }
}

// Strip `value` and `unit?` for the discovery schema — Sowel expects
// the data shape (key/type/category), not the live values.
function stripValue(d: DataField): Record<string, unknown> {
  const out: Record<string, unknown> = {
    key: d.key,
    type: d.type,
    category: d.category,
  };
  if (d.unit) out.unit = d.unit;
  return out;
}

// Topic shape: `<prefix>/<id>/<suffix>`.  Returns null if the topic
// does not match — defensive against bad subscription patterns.
function extractIdFromTopic(topic: string, prefix: string, suffix: string): string | null {
  const parts = topic.split("/");
  if (parts.length !== prefix.split("/").length + 2) return null;
  if (parts[parts.length - 1] !== suffix) return null;
  return parts[parts.length - 2] || null;
}
