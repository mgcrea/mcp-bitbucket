/**
 * The upstream error classes come from the client library, which already maps every
 * Bitbucket status to a typed error carrying an actionable `hint` — including the ones
 * only Bitbucket needs, like `GoneError` for the endpoints Atlassian removed and
 * `CapabilityError` for a credential that structurally cannot do what was asked.
 *
 * Re-exported rather than re-derived so there is one hierarchy, and `instanceof` keeps
 * working across the boundary.
 */
export {
  AuthenticationError,
  AuthorizationError,
  BitbucketApiError,
  BitbucketError,
  CapabilityError,
  ConflictError,
  describeError,
  GoneError,
  NetworkError,
  NotFoundError,
  OAuthError,
  RateLimitError,
  ResponseParseError,
  ServerError,
  TimeoutError,
  ValidationError,
} from "@mgcrea/bitbucket-cli";
export type { BitbucketErrorKind } from "@mgcrea/bitbucket-cli";

/** Thrown when a write path is reached while BITBUCKET_ALLOW_WRITES is off. */
export class WritesDisabledError extends Error {
  override readonly name = "WritesDisabledError";

  constructor(what: string) {
    super(
      `${what} is a write operation, but writes are disabled. ` +
        `Set BITBUCKET_ALLOW_WRITES=1 to enable mutating tools.`,
    );
  }
}

/**
 * Thrown before a request when a required argument has no value and no default.
 *
 * Separate from a zod validation error because the fix is different: the argument is
 * optional in the schema precisely so it can fall back to `BITBUCKET_WORKSPACE`, and
 * the useful message names both routes.
 */
export class MissingTargetError extends Error {
  override readonly name = "MissingTargetError";

  constructor(what: string, envVar: string) {
    super(`No ${what}. Pass it as an argument, or set ${envVar}.`);
  }
}
