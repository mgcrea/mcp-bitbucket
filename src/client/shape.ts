import type {
  CommitSummary,
  PullRequest,
  PullRequestSummary,
  Repository,
  RepositorySummary,
  UserRef,
} from "@mgcrea/bitbucket-cli";

export type Rec = Record<string, unknown>;

export const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * Collapse a user to one string.
 *
 * `UserRef` is already small, but a list of 50 pull requests carries 50 authors plus 50
 * reviewers, and a nested object per person costs four keys where one line reads just
 * as well. `@username` is kept because it is what the filter arguments take — dropping
 * it would force a second lookup to act on the result.
 */
export const formatUser = (user: UserRef | undefined): string | undefined => {
  if (user === undefined) return undefined;
  const handle = str(user.username) ?? str(user.nickname);
  return handle === undefined ? user.displayName : `${user.displayName} (@${handle})`;
};

/**
 * A pull request as a list row.
 *
 * The domain types out of the client library are already flat and camelCase — the
 * `links`, `rendered`, `summary` and embedded `source.repository` blocks that dominate
 * a raw Bitbucket payload are stripped before they reach here. So this layer only does
 * what the library cannot decide for us: which of the remaining fields a *list* should
 * carry, and how to spend fewer tokens on the people.
 */
export const summarizePullRequest = (pr: PullRequestSummary): Rec => ({
  id: pr.id,
  title: pr.title,
  state: pr.state,
  author: formatUser(pr.author),
  source: pr.source.name,
  destination: pr.destination.name,
  ...(pr.draft ? { draft: true } : {}),
  updatedAt: pr.updatedAt,
  url: pr.url,
  ...(pr.commentCount === undefined || pr.commentCount === 0
    ? {}
    : { commentCount: pr.commentCount }),
  ...(pr.taskCount === undefined || pr.taskCount === 0 ? {} : { taskCount: pr.taskCount }),
});

/**
 * One pull request in full — that is the point of a get, so nothing is trimmed except
 * the two things that are pure cost.
 *
 * `raw` is the client library's untouched-payload escape hatch. It holds a second,
 * complete copy of the Bitbucket object including the whole `links` block, so returning
 * it would roughly triple the response and undo every saving the normalize layer made.
 * `revision` is a Data Center concurrency token that is always undefined on Cloud.
 */
export const summarizePullRequestDetail = (pr: PullRequest): Rec => {
  const { raw: _raw, revision: _revision, author, reviewers, source, destination, ...rest } = pr;
  return {
    ...rest,
    author: formatUser(author),
    source: {
      branch: source.name,
      ...(source.repository ? { repository: source.repository } : {}),
    },
    destination: { branch: destination.name },
    // Flattened to `decision: [people]`, which is the question anyone actually asks of
    // this list, and is a third the size of an array of {user, decision, role}.
    reviewers: reviewers.reduce<Record<string, string[]>>((acc, reviewer) => {
      const name = formatUser(reviewer.user) ?? reviewer.user.displayName;
      (acc[reviewer.decision] ??= []).push(name);
      return acc;
    }, {}),
  };
};

export const summarizeRepository = (repo: RepositorySummary): Rec => ({
  fullName: repo.fullName,
  slug: repo.slug,
  isPrivate: repo.isPrivate,
  ...(repo.description ? { description: repo.description } : {}),
  ...(repo.language ? { language: repo.language } : {}),
  ...(repo.mainBranch ? { mainBranch: repo.mainBranch } : {}),
  ...(repo.updatedAt ? { updatedAt: repo.updatedAt } : {}),
});

/** Same rule as the pull request: a get returns everything but the `raw` duplicate. */
export const summarizeRepositoryDetail = (repo: Repository): Rec => {
  const { raw: _raw, ...rest } = repo;
  return rest;
};

export const summarizeCommit = (commit: CommitSummary): Rec => ({
  hash: commit.hash,
  // Bitbucket commit messages carry the full body. A list wants the subject; the body
  // is available from bitbucket_get_commit when it matters.
  message: commit.message.split("\n", 1)[0],
  author: formatUser(commit.author),
  date: commit.date,
});

/**
 * Keys that are pure self-reference in a raw Bitbucket payload.
 *
 * `links` is the big one: roughly twenty absolute URLs per object, all derivable from
 * the ids that are already present. `rendered` is every text field a second time as
 * HTML. `type` restates what the caller asked for.
 */
const NOISE_KEYS = new Set(["links", "rendered", "type"]);

/**
 * Strip the self-referential noise from a raw Bitbucket object.
 *
 * Used only for the endpoints the client library does not model — commits, refs,
 * source listings, projects — where the response really is raw Cloud JSON rather than
 * a normalized domain object. One level deep on purpose: `target` and `owner` nest one
 * more object with its own `links`, and going deeper than that starts mangling
 * genuinely useful structure.
 */
export const stripNoise = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripNoise);
  if (!isRecord(value)) return value;
  const out: Rec = {};
  for (const [key, entry] of Object.entries(value)) {
    if (NOISE_KEYS.has(key)) continue;
    if (entry === null) continue; // a null field costs tokens and says nothing
    out[key] = isRecord(entry) || Array.isArray(entry) ? stripNoise(entry) : entry;
  }
  return out;
};

/**
 * Unwrap a Bitbucket pagination envelope.
 *
 * `page`, `pagelen` and `size` only echo the request or are outright absent — Atlassian
 * guarantees only `values` and `next`. Leaving them in makes the model do arithmetic to
 * decide whether more exists, which it gets wrong. `has_more` removes the decision.
 *
 * `next` itself is deliberately NOT returned: it is an opaque absolute URL carrying a
 * cursor, and this server's tools page internally rather than handing one out. Reporting
 * `has_more` without the cursor tells the truth about what is left without inviting a
 * caller to paste a URL into the escape hatch.
 */
export const unwrapPage = (
  response: unknown,
  transform: (item: unknown) => unknown = stripNoise,
): Rec => {
  if (!isRecord(response)) return { values: [] };
  const values = Array.isArray(response.values) ? response.values.map(transform) : [];
  const total = typeof response.size === "number" ? response.size : undefined;
  return {
    values,
    ...(total === undefined ? {} : { total }),
    ...(str(response.next) === undefined ? {} : { has_more: true }),
  };
};

/**
 * Report a collected, internally-paginated read.
 *
 * When a bound cut the results short, say so and name the argument that would raise it.
 * Never truncate silently: a caller who does not know 400 rows were omitted will draw
 * conclusions from the 20 they got.
 */
export const collected = <T>(items: T[], limit: number, note?: string): Rec => ({
  count: items.length,
  values: items,
  ...(items.length >= limit
    ? {
        truncated: true,
        note:
          note ??
          `Stopped at the limit of ${limit}. Raise \`limit\`, or narrow the query, rather than ` +
            "assuming this is everything.",
      }
    : {}),
});
