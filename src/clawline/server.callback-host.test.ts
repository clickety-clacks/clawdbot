import { describe, expect, it } from "vitest";
import { resolveSurfAceCallbackHost } from "./server.js";

describe("resolveSurfAceCallbackHost", () => {
  it("appends .local for bare hostnames resolved from wildcard bind", () => {
    expect(resolveSurfAceCallbackHost("0.0.0.0", "TARS")).toBe("TARS.local");
  });

  it("does not append .local when hostname already has .local", () => {
    expect(resolveSurfAceCallbackHost("0.0.0.0", "tars.local")).toBe("tars.local");
  });

  it("does not append .local for IP addresses", () => {
    expect(resolveSurfAceCallbackHost("0.0.0.0", "192.168.50.25")).toBe("192.168.50.25");
    expect(resolveSurfAceCallbackHost("0.0.0.0", "::1")).toBe("::1");
  });

  it("does not append .local for FQDN hostnames with dots", () => {
    expect(resolveSurfAceCallbackHost("0.0.0.0", "gateway.example.internal")).toBe(
      "gateway.example.internal",
    );
  });

  it("applies the same rule to explicit bind hostnames", () => {
    expect(resolveSurfAceCallbackHost("TARS")).toBe("TARS.local");
    expect(resolveSurfAceCallbackHost("tars.internal")).toBe("tars.internal");
  });
});
