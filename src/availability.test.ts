import { describe, it, expect } from "vitest";
import { parseAvailability } from "./availability.js";

describe("parseAvailability", () => {
  it("online (lowercase) → 'online'", () => {
    expect(parseAvailability("online")).toBe("online");
  });

  it("offline (lowercase, with LWT padding) → 'offline'", () => {
    expect(parseAvailability("offline")).toBe("offline");
    expect(parseAvailability("  OFFLINE  \n")).toBe("offline");
  });

  it("case-insensitive", () => {
    expect(parseAvailability("Online")).toBe("online");
    expect(parseAvailability("ONLINE")).toBe("online");
  });

  it("garbage payload → null", () => {
    expect(parseAvailability("up")).toBeNull();
    expect(parseAvailability("")).toBeNull();
    expect(parseAvailability("{\"status\":\"online\"}")).toBeNull();
  });

  it("Buffer payload — decoded UTF-8", () => {
    expect(parseAvailability(Buffer.from("online", "utf-8"))).toBe("online");
  });
});
