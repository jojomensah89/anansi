# Main branch rules

The public repository uses the active GitHub ruleset **OSS main protection** on
`main`.

- Changes must arrive through a pull request.
- At least one approval is required.
- Stale approvals are dismissed when new commits are pushed.
- Conversations must be resolved.
- Required CI checks are `test`, `build-web`, and `build-extension`.
- The required checks must be current with the protected branch.
- Deleting `main` and force-pushing to `main` are blocked.
- Repository administrators may bypass the review requirement only when merging
  through a pull request; direct command-line updates remain subject to the
  rules.

The ruleset is configured in GitHub, not inferred from this file. If the
repository is recreated, the ruleset should be restored before accepting
external contributions.
