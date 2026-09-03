# @mgcrea/mcp-bitbucket

[![npm version](https://img.shields.io/npm/v/@mgcrea/mcp-bitbucket.svg?style=for-the-badge)](https://www.npmjs.com/package/@mgcrea/mcp-bitbucket)
[![ghcr](https://img.shields.io/badge/ghcr.io-mcp--bitbucket-blue?style=for-the-badge)](https://github.com/mgcrea/mcp-bitbucket/pkgs/container/mcp-bitbucket)

A Model Context Protocol server for the Bitbucket Cloud API — pull requests, repositories,
commits, file contents and pipelines, shaped so a list of fifty fits on a screen instead of
filling the context window.

**Read-only by default.** The mutating tools are not refused when writes are off, they are
never registered: they do not appear in `tools/list` and cannot be called at all. A refusal
still lets a model try, retry and reason about a way around it; a tool that does not exist
ends the conversation.

## Features

- **37 curated tools** across pull requests, repositories, workspaces, commits, branches,
  tags, file contents and pipelines, plus an escape hatch for everything else. 28 are
  registered read-only; the write flag adds 8, and an OAuth login adds a logout.
- **Read-only by default**, with `confirm: true` on the irreversible ones and a merge that
  defaults to a dry run.
- **Three auth methods** — Atlassian API token, OAuth 2.0 browser login, or a resource
  access token — and it reads an existing `bb` CLI login, so being signed in there is
  enough.
- **Stays up with no credentials**, answering `bitbucket_auth_status` with setup
  instructions rather than closing the connection with its own error message swallowed.
- **Server-side field projection.** Lists ask Bitbucket for the fields they need rather than
  trimming afterwards: 50 repositories go from ~162 kB to ~4 kB on the wire.
- **Diffs, logs and files come back as raw text**, not JSON-escaped into one unreadable line.
- **The API's traps are in the tool descriptions**, where they are read at the moment they
  matter — see [Traps worth knowing](#traps-worth-knowing).
- Native `fetch` and [`@mgcrea/bitbucket-cli`](https://github.com/mgcrea/bitbucket-cli) as
  the client. No HTTP library, no framework.

## Security

**Supply chain.** Three runtime dependencies: the MCP SDK, Zod, and our own Bitbucket
client — which itself has no HTTP dependency. Published from CI with OIDC trusted publishing
and npm provenance; container images are multi-arch and cosign-signed.

**Your credentials.** Read from the environment or a config file, never sent anywhere but
`api.bitbucket.org`. The escape-hatch tool refuses an absolute URL, a protocol-relative
path and any `..` segment, so it cannot be pointed at another host. `bitbucket_auth_status`
reports whether a credential is _present_, never its value. Credential files are written
0600, atomically. A world-readable one gets a warning rather than a refusal to start.

**Blast radius.** With the default configuration: read-only. Nothing this server can do
changes anything in Bitbucket. With `BITBUCKET_ALLOW_WRITES=1` it can additionally open,
update, merge and decline pull requests, review and comment on them, and start and stop
pipelines. Two of those deserve attention: **declining a pull request is irreversible** —
Bitbucket Cloud has no reopen endpoint — and **running a pipeline executes whatever
`bitbucket-pipelines.yml` says**, which may deploy. It cannot delete a repository or a
branch; those are not wrapped.

## Configure

Everything is optional. With nothing set the server starts and tells you what to set.

| Variable                        | Required       | Description                                                                                |
| ------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| `BITBUCKET_API_TOKEN`           | one of three   | Atlassian API token, created **with Bitbucket scopes**                                     |
| `BITBUCKET_EMAIL`               | recommended    | Your Atlassian email. Selects Basic over Bearer, which is what makes a scope error legible |
| `BITBUCKET_OAUTH_CLIENT_ID`     | one of three   | OAuth consumer key, for the browser login                                                  |
| `BITBUCKET_OAUTH_CLIENT_SECRET` | with the above | Consumer secret. Required — Bitbucket Cloud has no PKCE                                    |
| `BITBUCKET_ACCESS_TOKEN`        | one of three   | Repository, project or workspace access token                                              |
| `BITBUCKET_WORKSPACE`           | recommended    | Default workspace slug, so tools need not be told each time                                |
| `BITBUCKET_REPOSITORY`          | —              | Default repository slug. Needs `BITBUCKET_WORKSPACE`                                       |
| `BITBUCKET_ALLOW_WRITES`        | —              | `1` to register the eight mutating tools. Off by default                                   |
| `BITBUCKET_MAX_RETRIES`         | —              | Retries on 429 and 5xx, honouring `Retry-After`. Defaults to 3                             |
| `BITBUCKET_CONFIG`              | —              | Config file path. Defaults to `~/.config/bitbucket-mcp/config.json`                        |
| `BITBUCKET_HOSTS_FILE`          | —              | Where to read a `bb` login. Defaults to `~/.config/bb/hosts.yml`                           |
| `BITBUCKET_API_URL`             | —              | Different API root, for testing                                                            |
| `BITBUCKET_DEBUG`               | —              | Per-request lines on stderr                                                                |

`cp .env.example .env` — that file is the real documentation, annotated with why each
variable exists and which trap it avoids.

The same settings work in `~/.config/bitbucket-mcp/config.json` as camelCase keys
(`apiToken`, `allowWrites`, …). **The environment wins per field, not per source**, so a
one-off `BITBUCKET_ALLOW_WRITES=0` overrides a file that says `true` while leaving the rest
of the file in effect. The file schema is strict: a typo'd key is an error, because silently
ignoring one looks exactly like "that setting had no effect".

### Pick one auth method

**(A) Atlassian API token** — simplest, and right if you only need to read. Create one at
[id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) using
**"Create API token with scopes"** and select **Bitbucket** as the app. Set
`BITBUCKET_EMAIL` alongside it.

**(B) OAuth browser login** — a real login, refreshed automatically. Create a consumer under
_Workspace settings → Apps and features → OAuth consumers_ with its callback URL set to
exactly `http://localhost:8724/callback`, then set the id and secret and call
`bitbucket_auth_login`. Tick the permissions you want **on the consumer**: for writes, at
least `account`, `repository`, `pullrequest:write` and `pipeline:write`.

**(C) A resource access token** in `BITBUCKET_ACCESS_TOKEN`, for CI. No Atlassian account,
so anything needing an identity is unavailable.

**Already using the `bb` CLI?** Nothing to configure. This server reads
`~/.config/bb/hosts.yml`, so `bb auth login` covers it — including an OAuth refresh token.

## Quick start

### A. npx

```bash
claude mcp add bitbucket \
  --env BITBUCKET_API_TOKEN=... \
  --env BITBUCKET_EMAIL=you@example.com \
  --env BITBUCKET_WORKSPACE=your-workspace \
  -- npx -y @mgcrea/mcp-bitbucket
```

### B. Docker (stdio)

```bash
docker run --rm -i \
  -e BITBUCKET_API_TOKEN -e BITBUCKET_EMAIL -e BITBUCKET_WORKSPACE \
  ghcr.io/mgcrea/mcp-bitbucket:latest
```

### C. From source

```bash
pnpm install && pnpm build
cp .mcp.json.example .mcp.json   # then edit the path and the env
```

### Inspect the tools

```bash
npx @modelcontextprotocol/inspector node dist/cli.js
```

## Tools

Every tool takes optional `workspace` and `repository` arguments falling back to
`BITBUCKET_WORKSPACE` / `BITBUCKET_REPOSITORY`. **W** marks a tool that only exists with
`BITBUCKET_ALLOW_WRITES=1`; ⚠️ marks one that is irreversible and takes `confirm: true`.

**Start with `bitbucket_auth_status`.** If a tool you expected is not listed, that is
configuration or the write gate, not a bug — and it says which.

| Area          | Tools                                                                                                                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth          | `auth_status` `auth_login` `auth_logout`                                                                                                                                                                                                                                                                      |
| Workspaces    | `list_workspaces` `get_workspace` `list_projects` `get_project`                                                                                                                                                                                                                                               |
| Repositories  | `list_repositories` `get_repository`                                                                                                                                                                                                                                                                          |
| Pull requests | `list_pull_requests` `get_pull_request` `get_pull_request_diff` `list_pull_request_comments` `list_pull_request_commits` `list_pull_request_statuses` · **W** `create_pull_request` `update_pull_request` `review_pull_request` `comment_pull_request` · **W** ⚠️ `merge_pull_request` `decline_pull_request` |
| Commits       | `list_commits` `get_commit` `get_commit_diff` `list_commit_statuses`                                                                                                                                                                                                                                          |
| Code          | `get_file` `list_directory` `list_branches` `list_tags`                                                                                                                                                                                                                                                       |
| Pipelines     | `list_pipelines` `get_pipeline` `list_pipeline_steps` `get_pipeline_log` · **W** `run_pipeline` · **W** ⚠️ `stop_pipeline`                                                                                                                                                                                    |
| Escape hatch  | `request` `rate_limit_status`                                                                                                                                                                                                                                                                                 |

All names are prefixed `bitbucket_`. That is not cosmetic: MCP servers share one flat
namespace in the client, and an unprefixed `list_repositories` would collide with the next
server that wants the name.

## Reviewing a pull request end to end

The tools are ordered so this costs a few small responses rather than one enormous one.

```text
bitbucket_list_pull_requests                       → open PRs, one line each
bitbucket_get_pull_request           id: 42        → description, reviewers by decision
bitbucket_list_pull_request_statuses id: 42        → did CI pass?
bitbucket_get_commit_diff            spec: "main..feature", stat: true
                                                   → which files, how many lines
bitbucket_get_file                   path: "src/api.ts", revision: "feature"
                                                   → read only what matters
bitbucket_comment_pull_request       id: 42, body: "…", path: "src/api.ts", line: 87
bitbucket_review_pull_request        id: 42, decision: "approved"
bitbucket_merge_pull_request         id: 42        → a DRY RUN; reports what would happen
bitbucket_merge_pull_request         id: 42, dry_run: false, confirm: true
```

Reach for `bitbucket_get_pull_request_diff` only when you want the whole change at once —
`get_commit_diff` with `stat: true` is far smaller and usually answers the question.

## Traps worth knowing

These are all baked into the tool descriptions, where they are read at the moment they
matter. They are collected here because they explain the shape of this server.

1. **There is no cross-workspace anything.** Atlassian removed `GET /workspaces` and the
   cross-workspace `GET /repositories`; both now return HTTP 410. Every repository listing is
   workspace-scoped, and `bitbucket_list_workspaces` is the only way to discover a slug.
2. **The issue tracker is gone.** Those endpoints answer 410 and there is no replacement
   short of Jira. No tool here wraps them and none can.
3. **App passwords were removed on 2026-07-28.** An Atlassian API token created _with
   Bitbucket scopes_ is the replacement. A plain unscoped token authenticates and then fails
   every call with "API Token provided has no Bitbucket scopes".
4. **Bitbucket Cloud does not support PKCE**, so the browser login is a confidential-client
   flow and the consumer secret is needed for the life of the login, not just the exchange.
5. **OAuth scopes are fixed on the consumer.** Bitbucket ignores a `scope` parameter on a
   grant request, so this server cannot ask for what it needs — a consumer without
   `pullrequest:write` answers 403 on every merge. `bitbucket_auth_status` reports the
   granted set and warns when writes are enabled without them.
6. **Declining a pull request is final.** Cloud has no reopen endpoint. Mark a PR a draft
   instead if you only want to pause review.
7. **A single commit is `/commit/{sha}` and the list is `/commits`** — plural for the
   collection, singular for the item, unlike every other resource. The curated tools handle
   it; `bitbucket_request` will not.
8. **`main..feature` means destination-first**, the reverse of `git diff`. So
   `main..feature` shows what `feature` would bring into `main`.
9. **A `fields=` projection that whitelists anything must re-add the pagination keys**, or
   `next` is stripped and the result set silently truncates after one page. This is handled
   at one chokepoint in the client library; nothing here builds a `fields=` string by hand.
10. **Pipelines list oldest-first** by default, which surfaces a years-old run. This server
    forces newest-first. Pipeline status is a nested union its query language cannot address,
    so `status` is filtered client-side — combine a narrow filter with a generous `limit`.
11. **Pipeline logs expire long before the run record does**, so a 404 there usually means
    the log aged out rather than that the step never existed.
12. **A branch name with a slash is ambiguous** in a file path: `/src/{ref}/{path}` splits
    ref from path on the same separator. Prefer a commit hash.
13. **Rate limits are per credential per hour**, not per endpoint, and Bitbucket sends the
    headers on ordinary responses — so check `bitbucket_rate_limit_status` _before_ a large
    read, not after a 429. Atlassian documents that the headers are not returned on every
    response, so an empty report is normal.

## Troubleshooting

**The server does not appear, or shows "Connection closed".** It should never exit on missing
credentials — that is the one failure this design rules out. Run it by hand with the same
environment and read stderr: `node dist/cli.js`. The startup banner reports the resolved auth
method, workspace and write state before anything can fail.

**A tool I expected is not listed.** Call `bitbucket_auth_status`. Either the credential is
missing, or the tool is behind `BITBUCKET_ALLOW_WRITES`. An absent tool is usually the design
working.

**Everything 403s.** With an OAuth login, the consumer is probably missing a scope —
`bitbucket_auth_status` reports the granted set. Adding a permission means editing the
consumer and logging in again; re-authorising the existing one will not widen it.

**A 404 that should be a 401.** Bitbucket answers 404 for a private repository your
credential cannot see, so a missing repo and an unauthorised one look identical.

## Develop

```bash
pnpm install
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
```

Check the built server still speaks the protocol with no credentials at all:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| env HOME=/nonexistent node dist/cli.js 2>/dev/null | jq -r '.result.tools[]?.name'
```

### Publish

```bash
pnpm dlx release-it        # bump, commit, tag
git push --follow-tags     # CI publishes to npm and GHCR from the tag
```

## License

MIT
