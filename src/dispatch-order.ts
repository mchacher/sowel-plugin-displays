/**
 * Translate a Sowel order into the matching MQTT publish on the
 * `<prefix>/<id>/cmd/<key>` topic.
 *
 * The orderKey already IS the topic suffix — we declared orders with
 * keys aligned on the wire format (`language`, `brightness`) in
 * parse-state.ts, so the dispatch is a near-passthrough.  This module
 * only:
 *   1. Clamps numeric values to their declared range.
 *   2. Serialises everything to ASCII strings (MQTT cmd payloads are
 *      strings; the firmware parses them).
 *   3. Returns null for unknown orderKeys (caller logs + drops).
 */

export interface DispatchedOrder {
  topic: string;
  payload: string;
}

export function dispatchOrder(
  topicPrefix: string,
  sourceDeviceId: string,
  orderKey: string,
  value: unknown,
): DispatchedOrder | null {
  switch (orderKey) {
    case "brightness": {
      const n = clampNumber(value, 0, 100);
      if (n === null) return null;
      return {
        topic: `${topicPrefix}/${sourceDeviceId}/cmd/brightness`,
        payload: String(Math.round(n)),
      };
    }
    case "language": {
      if (typeof value !== "string" || value.length === 0) return null;
      return {
        topic: `${topicPrefix}/${sourceDeviceId}/cmd/language`,
        payload: value,
      };
    }
    default: {
      // Vendor-specific orders — passthrough as a string.  The firmware
      // ignores unknown topics with a log line (spec 121 contract), so
      // sending a future cmd/refresh_now to a display that does not
      // support it is harmless.
      if (value === undefined || value === null) return null;
      return {
        topic: `${topicPrefix}/${sourceDeviceId}/cmd/${orderKey}`,
        payload: String(value),
      };
    }
  }
}

function clampNumber(value: unknown, lo: number, hi: number): number | null {
  // null / undefined are NOT coerced — JS would turn null into 0 and
  // accidentally accept it as a valid brightness.
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
