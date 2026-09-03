import type { PullRequest, PullRequestSummary } from "@mgcrea/bitbucket-cli";
import { describe, expect, it } from "vitest";

import {
  collected,
  formatUser,
  stripNoise,
  summarizePullRequest,
  summarizePullRequestDetail,
  unwrapPage,
} from "#/client/shape";

const summary: PullRequestSummary = {
  id: 42,
  title: "Add a thing",
  state: "open",
  author: { displayName: "Ada Lovelace", username: "ada", uuid: "{u}" },
  source: { name: "feature", repository: "acme/api", commit: "abc" },
  destination: { name: "main", commit: "def" },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  url: "https://bitbucket.org/acme/api/pull-requests/42",
  draft: false,
  closeSourceBranch: false,
  commentCount: 0,
  taskCount: 3,
};

describe("formatUser", () => {
  it("collapses a user to one line, keeping the handle the filters take", () => {
    expect(formatUser({ displayName: "Ada Lovelace", username: "ada" })).toBe(
      "Ada Lovelace (@ada)",
    );
  });

  it("falls back to the nickname, then to the display name alone", () => {
    expect(formatUser({ displayName: "Ada", nickname: "al" })).toBe("Ada (@al)");
    expect(formatUser({ displayName: "Ada" })).toBe("Ada");
  });
});

describe("summarizePullRequest", () => {
  it("flattens the branches to names and the author to a line", () => {
    expect(summarizePullRequest(summary)).toEqual({
      id: 42,
      title: "Add a thing",
      state: "open",
      author: "Ada Lovelace (@ada)",
      source: "feature",
      destination: "main",
      updatedAt: "2026-01-02T00:00:00Z",
      url: "https://bitbucket.org/acme/api/pull-requests/42",
      taskCount: 3,
    });
  });

  it("spends no tokens on a zero count or a false flag", () => {
    const row = summarizePullRequest(summary);
    expect(row).not.toHaveProperty("commentCount");
    expect(row).not.toHaveProperty("draft");
  });

  it("does report a draft, since that decides whether it can merge", () => {
    expect(summarizePullRequest({ ...summary, draft: true })).toHaveProperty("draft", true);
  });
});

describe("summarizePullRequestDetail", () => {
  const detail: PullRequest = {
    ...summary,
    description: "Body text",
    reviewers: [
      { user: { displayName: "Bob", username: "bob" }, decision: "approved", role: "reviewer" },
      { user: { displayName: "Cyd", username: "cyd" }, decision: "approved", role: "reviewer" },
      {
        user: { displayName: "Dee", username: "dee" },
        decision: "changes-requested",
        role: "reviewer",
      },
    ],
    raw: { links: { self: { href: "…" } }, description: "Body text", huge: "x".repeat(10_000) },
  };

  it("drops `raw`, which is a whole second copy of the payload", () => {
    // The single most expensive thing in this response: returning it would roughly
    // triple the size and undo every saving the normalize layer made.
    const shaped = summarizePullRequestDetail(detail);
    expect(shaped).not.toHaveProperty("raw");
    expect(JSON.stringify(shaped)).not.toContain("xxxxx");
  });

  it("drops `revision`, which is always undefined on Cloud", () => {
    expect(summarizePullRequestDetail(detail)).not.toHaveProperty("revision");
  });

  it("groups reviewers by decision, which is the question anyone asks of the list", () => {
    expect(summarizePullRequestDetail(detail).reviewers).toEqual({
      approved: ["Bob (@bob)", "Cyd (@cyd)"],
      "changes-requested": ["Dee (@dee)"],
    });
  });

  it("keeps the description, because that is the point of a get", () => {
    expect(summarizePullRequestDetail(detail)).toHaveProperty("description", "Body text");
  });
});

describe("stripNoise", () => {
  it("removes the self-referential blocks that dominate a raw payload", () => {
    expect(
      stripNoise({
        name: "main",
        type: "branch",
        links: { self: { href: "https://api.bitbucket.org/…" }, html: { href: "…" } },
        rendered: { description: { html: "<p>…</p>" } },
      }),
    ).toEqual({ name: "main" });
  });

  it("drops nulls, which cost tokens and say nothing", () => {
    expect(stripNoise({ a: 1, b: null })).toEqual({ a: 1 });
  });

  it("reaches nested objects and arrays", () => {
    expect(
      stripNoise({ target: { hash: "abc", links: { self: 1 } }, values: [{ x: 1, type: "t" }] }),
    ).toEqual({ target: { hash: "abc" }, values: [{ x: 1 }] });
  });

  it("leaves a non-object alone", () => {
    expect(stripNoise("text")).toBe("text");
    expect(stripNoise(7)).toBe(7);
  });
});

describe("unwrapPage", () => {
  it("replaces the echoed request fields with a single has_more", () => {
    // page/pagelen only echo the request, and leaving them in makes the model do
    // arithmetic to decide whether more exists — which it gets wrong.
    expect(
      unwrapPage({
        page: 1,
        pagelen: 10,
        size: 25,
        values: [{ name: "a" }],
        next: "https://api.bitbucket.org/2.0/…?page=2",
      }),
    ).toEqual({ values: [{ name: "a" }], total: 25, has_more: true });
  });

  it("does not hand out the cursor, which is an opaque URL this server pages itself", () => {
    const result = unwrapPage({ values: [], next: "https://api.bitbucket.org/2.0/x?page=2" });
    expect(result).not.toHaveProperty("next");
    expect(JSON.stringify(result)).not.toContain("api.bitbucket.org");
  });

  it("omits has_more on the last page rather than saying false", () => {
    expect(unwrapPage({ values: [{ name: "a" }], size: 1 })).toEqual({
      values: [{ name: "a" }],
      total: 1,
    });
  });

  it("survives a response that is not a page at all", () => {
    expect(unwrapPage(null)).toEqual({ values: [] });
    expect(unwrapPage({ error: "x" })).toEqual({ values: [] });
  });

  it("strips noise from every row by default", () => {
    expect(unwrapPage({ values: [{ name: "a", links: { self: 1 } }] })).toEqual({
      values: [{ name: "a" }],
    });
  });
});

describe("collected", () => {
  it("says so when a bound cut the results short, and names the way to raise it", () => {
    // Never truncate silently: a caller who does not know rows were omitted will draw
    // conclusions from the ones they got.
    const result = collected([1, 2, 3], 3);
    expect(result.truncated).toBe(true);
    expect(String(result.note)).toMatch(/Raise `limit`/);
  });

  it("stays quiet when everything fitted", () => {
    expect(collected([1, 2], 25)).toEqual({ count: 2, values: [1, 2] });
  });
});
