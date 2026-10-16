# Commits, branching, and releases

## Commit conventions

Follow the [commit protocol](../../AGENTS.md#commit-protocol): explicit requests
authorize commit and push to `dev` together. Review staged content for secrets,
pass all [quality gates](../../CONTRIBUTING.md#quality-gates), and confirm green CI
after pushing. Never bypass hooks; amend or force-push only with authorization.

## Branching model

| Branch      | Purpose and merge path                                                                      |
| ----------- | ------------------------------------------------------------------------------------------- |
| `dev`       | Routine features, fixes, and documentation are committed directly here; no per-change PR    |
| `main`      | Released state; every merge is a tagged release with a GitHub Release                       |
| `feature/*` | Optional isolation for large or risky work; branch from and merge into `dev`                |
| `release/*` | Optional stabilization from `dev`; only fixes, version bumps, and changelog edits           |
| `hotfix/*`  | Urgent production fixes from `main`; merge into both `main` and `dev`, with a patch release |

`dev` blocks deletion/force-pushes. `main` requires an up-to-date PR passing
`quality`, `tests`, `security`, and `analyze`; the author may merge without another
approval. Optional feature PRs also require the full CI gate set.

## Releasing

1. On `dev`, review `git log <last-tag>..HEAD`; record every notable change under
   the new version/date and add a fresh empty `[Unreleased]` section above it.
2. Bump the version and open a `dev` → `main` PR (optionally stabilize on `release/*`).
3. After CI passes, use a merge commit, tag `vX.Y.Z`, and publish the GitHub Release.
4. Merge `main` back into `dev`.

Write changelog entries only at release time: one imperative sentence per notable
change with its commit link:

```markdown
- <Description> ([<7-char hash>](<commit URL>)).
```

Keep entries public-safe and outcome-focused (at most two rendered lines): omit
implementation details, rationale, people, personal services and guild-specific
content. Sanitize rather than drop entries; merge only entries sharing a commit
link. Mark breaking changes and link the operator guide through the README:
`(**breaking** — see [README.md](README.md))`.

## Submitting a PR

For releases, hotfixes and optional large/risky work, run local gates and fill in
the PR template with behavior, validation and rollback. Review the diff/CI, merge
after required checks pass, and delete short-lived branches.
