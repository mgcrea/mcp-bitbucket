import type { RateLimitSnapshot } from "@mgcrea/bitbucket-cli";

export type RateLimitReport = {
  /** Total permitted per window. */
  limit?: number | undefined;
  window_seconds?: number | undefined;
  remaining?: number | undefined;
  reset_at?: string | undefined;
  /** Atlassian sets this once less than 20% of the quota is left. */
  near_limit?: boolean | undefined;
  observed_at?: string | undefined;
  /** How many requests this server has sent since it started. */
  requests_this_session: number;
  note?: string | undefined;
};

export type RateLimitRecorder = {
  record(snapshot: RateLimitSnapshot): void;
  countRequest(): void;
  report(): RateLimitReport;
};

/**
 * Keeps the most recent rate-limit reading.
 *
 * Deliberately one global snapshot rather than a map keyed by endpoint, which is what
 * the other servers in this fleet do. Bitbucket's quota is per credential per hour, and
 * `RateLimitSnapshot` carries no endpoint at all — so a per-endpoint breakdown would be
 * inventing structure the API does not report, and every bucket would show the same
 * numbers under a misleading label.
 *
 * Worth keeping even when nothing has failed: Bitbucket sends these headers on ordinary
 * responses, so a caller can check the budget *before* a large paginated read rather
 * than discovering it through a 429.
 */
export const createRateLimitRecorder = (): RateLimitRecorder => {
  let latest: RateLimitSnapshot | undefined;
  let requests = 0;
  return {
    record: (snapshot) => {
      latest = snapshot;
    },
    countRequest: () => {
      requests += 1;
    },
    report: () => {
      if (latest === undefined) {
        return {
          requests_this_session: requests,
          note:
            requests === 0
              ? "No requests made yet this session, so Bitbucket has not reported a budget."
              : // Atlassian documents that these headers are "not necessarily returned on
                // every response", so their absence is normal and not a fault.
                "Bitbucket has not returned any rate-limit headers yet. It does not send them " +
                "on every response, so this is normal rather than a problem.",
        };
      }
      return {
        ...(latest.limit === undefined ? {} : { limit: latest.limit }),
        ...(latest.window === undefined ? {} : { window_seconds: latest.window }),
        ...(latest.remaining === undefined ? {} : { remaining: latest.remaining }),
        ...(latest.resetAt === undefined ? {} : { reset_at: latest.resetAt.toISOString() }),
        near_limit: latest.nearLimit,
        observed_at: latest.observedAt.toISOString(),
        requests_this_session: requests,
      };
    },
  };
};
