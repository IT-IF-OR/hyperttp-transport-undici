import { describe, it, expect } from "vitest";
import { fastParseUrl, normalizeHeaders } from "../src/utils/helpers.js";

describe("Pure Helper Functions", () => {
  describe("normalizeHeaders", () => {
    it("returns empty object on falsy values", () => {
      expect(normalizeHeaders(null as never)).toEqual({});
      expect(normalizeHeaders(undefined as never)).toEqual({});
    });

    it("handles headers arrays (undici native format)", () => {
      const raw = ["Content-Type", "application/json", "X-CUSTOM", "value"];
      expect(normalizeHeaders(raw as never)).toEqual({
        "content-type": "application/json",
        "x-custom": "value",
      });
    });

    it("filters out empty keys or missing values in arrays", () => {
      const raw = ["", "invalid", "Valid-Key", null];
      expect(normalizeHeaders(raw as never)).toEqual({});
    });

    it("handles object structures and skips undefined properties", () => {
      const obj = {
        "X-Test": undefined,
        "Content-Type": "text/html",
        "X-Custom-Header": "working",
      };
      expect(normalizeHeaders(obj as never)).toEqual({
        "content-type": "text/html",
        "x-custom-header": "working",
      });
    });

    it("joins array values correctly", () => {
      const obj = {
        "Cache-Control": ["no-cache", "no-store"],
        "Set-Cookie": ["a=1", "b=2"],
      };
      expect(normalizeHeaders(obj as never)).toEqual({
        "cache-control": "no-cache, no-store",
        "set-cookie": "a=1\nb=2",
      });
    });
  });

  describe("fastParseUrl", () => {
    const BASE = "http://localhost:3000";

    it("resolves relative paths against the base url", () => {
      expect(fastParseUrl("/users?q=1", BASE)).toEqual({
        origin: BASE,
        path: "/users?q=1",
        fullUrl: `${BASE}/users?q=1`,
      });
    });

    it("resolves root path", () => {
      expect(fastParseUrl("/", BASE)).toEqual({
        origin: BASE,
        path: "/",
        fullUrl: `${BASE}/`,
      });
    });

    it("parses absolute urls", () => {
      expect(fastParseUrl("http://example.com/a", BASE)).toEqual({
        origin: "http://example.com",
        path: "/a",
        fullUrl: "http://example.com/a",
      });
    });

    it("parses origin-only urls as root path", () => {
      expect(fastParseUrl("http://example.com", BASE)).toEqual({
        origin: "http://example.com",
        path: "/",
        fullUrl: "http://example.com/",
      });
    });

    it("parses query-only urls", () => {
      expect(fastParseUrl("http://example.com?q=1", BASE)).toEqual({
        origin: "http://example.com",
        path: "/?q=1",
        fullUrl: "http://example.com/?q=1",
      });
    });

    it("strips hash fragments", () => {
      expect(fastParseUrl("/users#section", BASE)).toEqual({
        origin: BASE,
        path: "/users",
        fullUrl: `${BASE}/users`,
      });
    });

    it("handles protocol-relative urls as https", () => {
      expect(fastParseUrl("//example.com/x", BASE)).toEqual({
        origin: "https://example.com",
        path: "/x",
        fullUrl: "https://example.com/x",
      });
    });

    it("falls back to the native URL parser for userinfo", () => {
      expect(fastParseUrl("http://user:pass@example.com/", BASE)).toEqual({
        origin: "http://example.com",
        path: "/",
        fullUrl: "http://example.com/",
      });
    });
  });
});
