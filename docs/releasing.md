# Release checklist

Desktop releases are built only from an existing semantic-version tag such as
`v1.2.3`. The `release` GitHub Environment is the approval gate for creating a
draft release.

Before tagging:

1. Ensure CI passes, including repository-health and full-history secret scans.
2. Review Dependabot alerts and dependency changes in all lockfiles.
3. Configure valid Windows signing secrets (`WIN_CSC_LINK` and
   `WIN_CSC_KEY_PASSWORD`). Windows packaging fails closed when signing is
   unavailable. macOS signing and notarization remain optional for the current
   early-access channel.
4. Confirm GitHub secret scanning, push protection, private vulnerability
   reporting, branch rulesets, and the `release` Environment are enabled.
5. Create and push the version tag. Do not reuse or move a published tag.

The workflow creates platform installers, updater metadata, SHA-256 checksums,
a CycloneDX SBOM, and GitHub artifact attestations. It then creates a draft
Release. Before publishing the draft, install every platform artifact on a clean
machine and verify first launch, sidecar startup, deep links, task execution,
update deferral while work is active, upgrade, and uninstall behavior.

If a secret is ever committed, revoke it before rewriting Git history. Coordinate
history rewriting with contributors and forks; deleting a branch or force-pushing
does not itself revoke a credential.
