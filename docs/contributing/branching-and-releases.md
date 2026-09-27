# Commits, branching, and releases

Part of the [contributing guide](../../CONTRIBUTING.md).

## Commit conventions

Use `<type>(<scope>): <subject>` with an imperative subject and a type of
`feat`, `fix`, `refactor`, `chore`, `docs`, or `test`. Keep changes focused;
explain non-obvious reasons in the body. Do not add AI-attribution trailers.

Commit only when explicitly requested; that request includes pushing to
`dev`. First review staged content for secrets and pass every local
[quality gate](../../CONTRIBUTING.md#quality-gates), then confirm CI is green
after the push. Never amend, bypass hooks, or force-push without authorization.

## Branching model

| Branch      | Purpose and merge path                                                                      |
| ----------- | ------------------------------------------------------------------------------------------- |
| `dev`       | Routine features, fixes, and documentation are committed directly here; no per-change PR    |
| `main`      | Released state; every merge is a tagged release with a GitHub Release                       |
| `feature/*` | Optional isolation for large or risky work; branch from and merge into `dev`                |
| `release/*` | Optional stabilization from `dev`; only fixes, version bumps, and changelog edits           |
| `hotfix/*`  | Urgent production fixes from `main`; merge into both `main` and `dev`, with a patch release |

`dev` protection blocks deletion and force-pushes. `main` requires a PR that
includes its latest changes and passes `quality`, `tests`, `security`, and
`analyze`. The author may merge after checks pass; another approval is not
required. Optional feature PRs must also pass the full CI gate set.

## Releasing

1. On `dev`, review `git log <last-tag>..HEAD`. Rename `[Unreleased]` to the
   new version and date, record every notable change, and add a fresh empty
   `[Unreleased]` section above it.
2. Bump the version and open a `dev` → `main` PR (or use a `release/*`
   stabilization branch). Follow the PR procedure below.
3. After CI passes, merge into `main` with a merge commit, tag `vX.Y.Z`, and
   publish the GitHub Release.
4. Merge `main` back into `dev` to keep release history synchronized.

Write changelog entries only at release time, one per notable change, with
an imperative sentence and the commit link:

```markdown
- <Description> ([<7-char hash>](<commit URL>)).
```

Entries are public and permanent. Keep each to one sentence (at most two
rendered lines) describing the user or operator outcome. Omit implementation
details, rationale, individuals, nicknames, personal services, and guild-specific
content. Keep breaking changes marked, linking to the relevant operator guide
through the README: `(**breaking** — see [README.md](README.md))`.
Shorten or sanitize an entry instead of dropping it; merge entries only when
they share a commit link.

## Submitting a PR

PRs cover releases, hotfixes, and optional large or risky work.
Run the local gates, fill in the PR template with the behavior change,
validation evidence, and rollback plan, then review the diff and CI results.
Merge only after required checks pass and delete short-lived branches afterward.
