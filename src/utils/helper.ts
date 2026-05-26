import type { RetryOptions } from "@hyperttp/types";

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_RETRY_STATUS_CODES = [502, 503, 504];

export function normalizeHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null);

  if (!headers) return out;

  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      const key = (headers[i] as string).toLowerCase();
      if (!key) continue;

      const value = headers[i + 1];
      if (value === undefined || value === null) continue;

      out[key] = typeof value === "string" ? value : String(value);
    }
    return out;
  }

  const headerObj = headers as Record<string, string | string[] | undefined>;

  for (const [key, val] of Object.entries(headerObj)) {
    if (val === undefined) continue;

    const lower = key.toLowerCase();

    if (Array.isArray(val)) {
      out[lower] = lower === "set-cookie" ? val.join("\n") : val.join(", ");
    } else {
      out[lower] = String(val);
    }
  }

  return out;
}

export function isRedirect(status: number): boolean {
  return REDIRECT_STATUS_CODES.has(status);
}

export function shouldRetry(
  status: number,
  retryOptions: RetryOptions,
): boolean {
  const codes = retryOptions.retryStatusCodes;
  if (codes && codes.length > 0) {
    return codes.includes(status);
  }

  return DEFAULT_RETRY_STATUS_CODES.includes(status);
}

export function calcDelay(attempt: number, retryOptions: RetryOptions): number {
  const { baseDelay = 1000, maxDelay = 10000, jitter = true } = retryOptions;

  const base = Math.min(baseDelay * 2 ** attempt, maxDelay);
  return jitter ? base * (0.75 + Math.random() * 0.5) : base;
}

export async function drainBody(body: unknown): Promise<void> {
  if (!body || typeof body !== "object") return;

  try {
    const stream = body as Record<string, unknown>;

    if (typeof stream.dump === "function") {
      await (stream.dump as () => Promise<void>)();
      return;
    }

    if (typeof stream.resume === "function") {
      (stream.resume as () => void)();
      return;
    }

    if (typeof stream.destroy === "function") {
      (stream.destroy as () => void)();
    }
  } catch {
    // ignore disposal noise
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function combineSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal?: AbortSignal;
  cancelTimer: () => void;
  isTimeoutAbort: () => boolean;
} {
  if (timeoutMs <= 0) {
    return {
      signal,
      cancelTimer: () => {},
      isTimeoutAbort: () => false,
    };
  }

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

  let combinedSignal: AbortSignal;
  if (signal) {
    if (typeof AbortSignal.any === "function") {
      combinedSignal = AbortSignal.any([signal, timeoutController.signal]);
    } else {
      signal.addEventListener("abort", () => timeoutController.abort(), {
        once: true,
      });
      combinedSignal = timeoutController.signal;
    }
  } else {
    combinedSignal = timeoutController.signal;
  }

  return {
    signal: combinedSignal,
    cancelTimer: () => clearTimeout(timer),
    isTimeoutAbort: () => timeoutController.signal.aborted,
  };
}
