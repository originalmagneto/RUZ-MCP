type Bucket = {
  tokens: number;
  lastRefillMs: number;
};

export type RateLimiterOptions = {
  /** Long-run replenishment rate in requests per minute. */
  ratePerMinute: number;
  /** Maximum burst capacity (also the steady-state bucket size). */
  burst: number;
  /** Maximum number of distinct keys to retain. Oldest entries are evicted. */
  maxKeys?: number;
  /** Inactivity window after which a bucket is forgotten. */
  inactivityMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
};

export type RateLimiter = {
  /**
   * Consume one token for `key`. Returns whether the request is allowed and,
   * when denied, how many seconds the caller should wait before retrying.
   */
  check(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number };
};

/**
 * In-memory token-bucket rate limiter. Designed for a single-process MCP server.
 * If the server is ever horizontally scaled, this needs to move to a shared store.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const ratePerMs = options.ratePerMinute / 60_000;
  const burst = Math.max(1, options.burst);
  const maxKeys = options.maxKeys ?? 10_000;
  const inactivityMs = options.inactivityMs ?? 10 * 60_000;
  const now = options.now ?? (() => Date.now());

  const buckets = new Map<string, Bucket>();

  function refill(bucket: Bucket, currentMs: number): void {
    const elapsed = currentMs - bucket.lastRefillMs;
    if (elapsed <= 0) return;
    bucket.tokens = Math.min(burst, bucket.tokens + elapsed * ratePerMs);
    bucket.lastRefillMs = currentMs;
  }

  function evictIfNeeded(currentMs: number): void {
    if (buckets.size < maxKeys) return;
    for (const [key, bucket] of buckets) {
      if (currentMs - bucket.lastRefillMs > inactivityMs) {
        buckets.delete(key);
      }
      if (buckets.size < maxKeys) return;
    }
    // Hard cap: drop the oldest insertion if still over the limit.
    const oldest = buckets.keys().next().value;
    if (typeof oldest === "string") {
      buckets.delete(oldest);
    }
  }

  return {
    check(key) {
      const currentMs = now();
      let bucket = buckets.get(key);
      if (!bucket) {
        evictIfNeeded(currentMs);
        bucket = { tokens: burst, lastRefillMs: currentMs };
        buckets.set(key, bucket);
      } else {
        refill(bucket, currentMs);
      }

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { allowed: true };
      }

      const missing = 1 - bucket.tokens;
      const waitMs = ratePerMs > 0 ? missing / ratePerMs : Number.POSITIVE_INFINITY;
      const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));
      return { allowed: false, retryAfterSeconds };
    }
  };
}
