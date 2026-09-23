# Commits, branching, and releases

Part of the [contributing guide](../../CONTRIBUTING.md).

## Commit conventions

The Git history follows a `<type>(<scope>): <subject>` pattern where
`<type>` is `feat`, `fix`, `refactor`, `chore`, `docs`, or `test`, and
`<scope>` matches the area being touched (`llm-chat`, `scanner`,
etc.). Multi-line bodies are encouraged for non-trivial changes —
describe the _why_, not the _what_.

## Branching model

This repo follows a **Git Flow** variant with two long-lived branches:
`main` (released) and `dev` (integration).

- **`main`** — always equals the released / production state. Every merge
  into `main` is a release: it is tagged (`vX.Y.Z`) and a GitHub Release
  is cut from it. `main` is the **only** branch that enforces the full
  required CI gate set (`quality`, `tests`, `security`, `analyze`) on
  the `dev` → `main` release PR. A PR is required, but no approval is
  required so the author can merge after the checks pass. The PR branch
  must include the latest `main` changes.
- **`dev`** — the integration branch, and the one you **commit to
  directly**. Routine work (features, fixes, docs) lands on `dev` without
  a per-change branch or PR. Before pushing, run the full local gate
  suite (see [Quality gates](../../CONTRIBUTING.md#quality-gates)) —
  that is the discipline that keeps `dev` healthy. A push to `dev` still
  runs the local pre-push gates, then triggers CI as a post-push safety
  signal, not a merge gate. `dev` branch protection blocks force-pushes
  and deletion, including for administrators.
- **`feature/*` (optional)** — for large or risky changes, or when you
  want a pre-merge CI gate / review, branch off `dev`, open a PR back
  into `dev`, and delete the branch on merge. Otherwise commit straight
  to `dev`.
- **Releasing** — first write the changelog: on `dev`, walk
  `git log <last tag>..HEAD`, rename `[Unreleased]` to the new version
  and date, file one entry per notable commit under it (format and
  content rules in [Architectural rule 4](../../CONTRIBUTING.md#architectural-rules)),
  and open a fresh empty `[Unreleased]` above it. Then bump the version
  and open a `dev` → `main` PR (optionally via a `release/*`
  stabilisation branch that takes only bug fixes, version bumps, and
  changelog edits). The full required CI gate set must be green. After
  merging into `main` with a merge commit, tag the release + cut the
  GitHub Release, then merge `main` back into `dev` so the branches
  do not drift.
- **`hotfix/*`** — for production-urgent fixes, branch off `main`; merge
  back into **both** `main` (tag a patch release) and `dev`.

The `dev` → `main` release PR (and any optional `feature/*` PR) must pass
the full required CI gate set before it can merge.

## Submitting a PR

PRs are for `dev` → `main` releases, hotfixes, and optional large /
risky `feature/*` work. **Routine `dev` work does not need a PR — commit
it directly to `dev`** after the local gate suite passes.

When you do open a PR:

1. Branch off `dev` for large features, or `main` for hotfixes. A
   regular release PR uses `dev` as its source branch; an optional
   `release/*` stabilization branch starts from `dev`.
2. Run the full local gate suite (see
   [Quality gates](../../CONTRIBUTING.md#quality-gates)).
3. Fill in the PR template — it asks for a summary, gate evidence,
   and a rollback plan.
4. Review the diff and gate evidence. CI must be green before merge;
   the PR author may merge without another approval. Delete short-lived
   branches after merging.
