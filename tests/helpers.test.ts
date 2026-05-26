import { describe, it, expect, vi } from "vitest";
import { drainBody, normalizeHeaders } from "../src/utils/helper";

describe("Pure Helper Functions", () => {
  describe("normalizeHeaders", () => {
    it("returns empty object on falsy values", () => {
      expect(normalizeHeaders(null)).toEqual({});
      expect(normalizeHeaders(undefined)).toEqual({});
    });

    it("handles headers arrays (undici native format)", () => {
      const raw = ["Content-Type", "application/json", "X-CUSTOM", "value"];
      expect(normalizeHeaders(raw)).toEqual({
        "content-type": "application/json",
        "x-custom": "value",
      });
    });

    it("filters out empty keys or missing values in arrays", () => {
      const raw = ["", "invalid", "Valid-Key", null];
      expect(normalizeHeaders(raw)).toEqual({});
    });

    it("handles object structures and skips undefined properties", () => {
      const obj = {
        "X-Test": undefined,
        "Content-Type": "text/html",
        "X-Custom-Header": "working",
      };
      expect(normalizeHeaders(obj)).toEqual({
        "content-type": "text/html",
        "x-custom-header": "working",
      });
    });

    it("joins array values correctly", () => {
      const obj = {
        "Cache-Control": ["no-cache", "no-store"],
        "Set-Cookie": ["a=1", "b=2"],
      };
      expect(normalizeHeaders(obj)).toEqual({
        "cache-control": "no-cache, no-store",
        "set-cookie": "a=1\nb=2",
      });
    });
  });

  describe("drainBody", () => {
    it("gracefully leaves non-objects", async () => {
      await expect(drainBody(null)).resolves.not.toThrow();
      await expect(drainBody("string")).resolves.not.toThrow();
    });

    it("supports stream.dump()", async () => {
      const mockStream = { dump: vi.fn().mockResolvedValue(undefined) };
      await drainBody(mockStream);
      expect(mockStream.dump).toHaveBeenCalled();
    });

    it("supports stream.resume()", async () => {
      const mockStream = { resume: vi.fn() };
      await drainBody(mockStream);
      expect(mockStream.resume).toHaveBeenCalled();
    });

    it("supports stream.destroy()", async () => {
      const mockStream = { destroy: vi.fn() };
      await drainBody(mockStream);
      expect(mockStream.destroy).toHaveBeenCalled();
    });

    it("ignores errors thrown during disposal", async () => {
      const brokenStream = {
        dump: vi.fn().mockRejectedValue(new Error("Destruction fail")),
      };
      await expect(drainBody(brokenStream)).resolves.not.toThrow();
    });
  });
});
