/**
 * Parse the `<prefix>/<id>/availability` payload — either `online` or
 * `offline`.  The LWT publishes `offline` on hard disconnect; the
 * display republishes `online` on (re)connect.
 *
 * Lenient: case-insensitive, trims surrounding whitespace.  Returns
 * null on any other content so the caller can log + drop.
 */

export type Availability = "online" | "offline";

export function parseAvailability(payload: string | Buffer): Availability | null {
  const text = (typeof payload === "string" ? payload : payload.toString("utf-8"))
    .trim()
    .toLowerCase();
  if (text === "online") return "online";
  if (text === "offline") return "offline";
  return null;
}
