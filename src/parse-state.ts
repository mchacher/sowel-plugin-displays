/**
 * Pure parser for the `sowel-display/<id>/state` JSON payload.
 *
 * Canonical field → DataCategory mapping (spec 121):
 *   id           → not a data row, used as sourceDeviceId
 *   version      → firmware_version  (text)
 *   uptime_s     → uptime            (number, seconds)
 *   hostname     → not a data row, used as Device.name
 *   ip           → generic            (key "ip_address", text)
 *   rssi         → rssi               (number, dBm)
 *   language     → language           (text, ISO 639-1)
 *   brightness   → display_brightness (number, 0..100)
 *   any other    → generic            (key = the JSON field name)
 *
 * Permissive: every field is parsed independently inside a try/catch
 * so a malformed `rssi` does not poison the parse of `brightness`.
 * Missing fields are simply omitted from the output.
 */

export interface DataField {
  key: string;
  type: "text" | "number" | "boolean" | "enum";
  category: string;
  value: unknown;
  unit?: string;
}

export interface OrderField {
  key: string;
  type: "text" | "number" | "boolean" | "enum";
  category: string;
  enumValues?: string[];
  min?: number;
  max?: number;
  unit?: string;
}

export interface ParsedState {
  /** Mandatory — used to key the device. Null if absent / unparseable. */
  id: string | null;
  /** Recommended — used to seed Device.name. Falls back to `id` when absent. */
  hostname: string | null;
  /** Each canonical / vendor-specific field, ready for updateDeviceData. */
  data: DataField[];
  /**
   * Order schema the plugin should declare for this device at first
   * discovery. Derived from which state fields were observed: a display
   * that never reports `language` ends up with no `set_language` order
   * (spec 121 D3 — polymorphism payoff).
   */
  orders: OrderField[];
}

/**
 * Parse the JSON body of a state publish.  Returns null only if the
 * payload is unparseable JSON or not a plain object.  Otherwise returns
 * a `ParsedState` whose data array may be empty if no recognised field
 * was present.
 */
export function parseState(payload: string | Buffer): ParsedState | null {
  let json: unknown;
  try {
    const text = typeof payload === "string" ? payload : payload.toString("utf-8");
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const obj = json as Record<string, unknown>;

  const id = typeof obj.id === "string" && obj.id.length > 0 ? obj.id : null;
  const hostname = typeof obj.hostname === "string" && obj.hostname.length > 0
    ? obj.hostname
    : null;

  const data: DataField[] = [];
  const orders: OrderField[] = [];

  // Mandatory fields
  if (typeof obj.version === "string") {
    data.push({
      key: "firmware_version",
      type: "text",
      category: "firmware_version",
      value: obj.version,
    });
  }
  if (typeof obj.uptime_s === "number" && Number.isFinite(obj.uptime_s)) {
    data.push({
      key: "uptime",
      type: "number",
      category: "uptime",
      value: obj.uptime_s,
      unit: "s",
    });
  }

  // Recommended fields
  if (typeof obj.hostname === "string" && obj.hostname.length > 0) {
    data.push({
      key: "hostname",
      type: "text",
      category: "generic",
      value: obj.hostname,
    });
  }
  if (typeof obj.ip === "string" && obj.ip.length > 0) {
    data.push({
      key: "ip_address",
      type: "text",
      category: "generic",
      value: obj.ip,
    });
  }
  if (typeof obj.rssi === "number" && Number.isFinite(obj.rssi)) {
    data.push({
      key: "rssi",
      type: "number",
      category: "rssi",
      value: obj.rssi,
      unit: "dBm",
    });
  }
  if (typeof obj.language === "string" && obj.language.length > 0) {
    data.push({
      key: "language",
      type: "text",
      category: "language",
      value: obj.language,
    });
    orders.push({
      key: "language",
      type: "text",
      category: "set_language",
    });
  }
  if (typeof obj.brightness === "number" && Number.isFinite(obj.brightness)) {
    data.push({
      key: "brightness",
      type: "number",
      category: "display_brightness",
      value: clamp(obj.brightness, 0, 100),
      unit: "%",
    });
    orders.push({
      key: "brightness",
      type: "number",
      category: "set_display_brightness",
      min: 0,
      max: 100,
      unit: "%",
    });
  }

  // Spec 122 — `wake: true` advertises the display's capability to
  // restore its last user-chosen brightness via the `cmd/wake` topic.
  // No corresponding data row (it is a capability flag, not telemetry).
  // The recipe presence-display uses this order so it does not need to
  // know the user's preferred brightness level.
  if (obj.wake === true) {
    orders.push({
      key: "wake",
      type: "boolean",
      category: "display_wake",
    });
  }

  // Vendor-specific extras — anything not already handled, in any
  // primitive shape, lands as a `generic` data row keyed by the JSON
  // field name.  Lets a future firmware add `battery_pct` / `sleep_s` /
  // `temperature_internal` without a plugin upgrade.
  const HANDLED = new Set([
    "id",
    "hostname",
    "version",
    "uptime_s",
    "ip",
    "rssi",
    "language",
    "brightness",
    "wake",
  ]);
  for (const [key, value] of Object.entries(obj)) {
    if (HANDLED.has(key)) continue;
    const t = typeOf(value);
    if (!t) continue;
    data.push({
      key,
      type: t,
      category: "generic",
      value,
    });
  }

  return { id, hostname, data, orders };
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function typeOf(value: unknown): DataField["type"] | null {
  if (typeof value === "string") return "text";
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (typeof value === "boolean") return "boolean";
  return null;
}
