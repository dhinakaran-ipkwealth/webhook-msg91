PR Preparation Instructions

This repository has been refactored into a Clean Architecture layout under `src/` and has accompanying unit tests in `test/`.

To create a branch, commit the current workspace changes and prepare a PR branch, run:

```sh
git checkout -b refactor/clean-architecture
git add .
git commit -m "refactor: adopt Clean Architecture for webhook & electron; add use-cases, gateways, controllers, and tests"
git push -u origin refactor/clean-architecture
```

To create a patch file suitable for attaching to a PR review (format-patch):

```sh
# after committing on the branch
git format-patch origin/main --stdout > ../clean-architecture.patch
```

If your default branch is `master` or `main` use that name instead of `origin/main`.

Notes:
- The patch above includes all staged changes as a single commit. For a multi-commit history, commit progressively before running `format-patch`.
- Run the test suite before creating PR: `npm test`
