# Changelog

Notable user-facing changes are recorded here. WorkStep follows semantic versioning for tagged desktop releases.

## Unreleased

No unreleased changes recorded.

## 1.0.16

### Highlights

- Clarify task lifecycle states, pending confirmations, waiting, failures, and manual stops. Improve parallel review continuation and protect active tasks from destructive actions.
- Preserve multi-window chat layouts and sizes when navigating away and back within the same page session, isolated by account and device. Browser refresh persistence is not guaranteed.
- Unify Git merge and remote action panels.
- Expand the website and complete user manual to 26 languages, with mobile layout, search, and website RTL improvements. Additional translations still need independent native-language review.
- Refresh the website to match the product's white, gray, and blue interface; retain the product walkthrough, animations, and documentation. Add localized onboarding, pricing, support, and public terms.
- Improve root-filesystem capacity checks after macOS AppleHV sandbox disk expansion.
- Pin optional DeepSeek Harness SDK installation and updates to 0.2.1rc2. Restore persisted sessions explicitly in a new runtime while retaining the Chat Completions provider contract; preserve the original session and report recovery failures instead of silently starting over.
- Retry a newly announced Codex thread from the original prompt when it fails before producing turn content or tool events, without attempting to resume a rollout that does not yet exist.
- Standardize public release notes in English, including historical GitHub Releases and future release generation.

### Downloads and updates

Windows x64 installer, macOS Apple Silicon and Intel DMGs, and Linux x64 AppImage are available from GitHub Releases. Packages are intentionally unsigned and not notarized; operating-system security warnings are expected. Desktop settings check the latest published Release daily and link to GitHub for manual download and installation; there is no automatic installation or restart.

Sandbox image: `ghcr.io/xzregg/workstep:v1.0.16`, published alongside `latest`, for Linux amd64 and arm64. Windows hosts require WSL2/Podman; this is not a native Windows container image. Desktop packages pin the release image's immutable digest.

### Validation boundaries

Release publication requires passing source CI, native Windows installer acceptance, and both macOS DMG acceptance jobs. Automated checks do not replace real authenticated LLM calls, Windows 10/11 or macOS security-prompt checks, Podman/WSL2 sandbox validation, native notifications, external-browser handoff, or clean-machine Linux desktop acceptance. The manual retains 13 registered screenshot gaps and older screenshots awaiting updates. See the release workflow's acceptance reports for artifact-specific evidence.

## 1.0.15

### Highlights

- Open up to four project-chat panes across different projects and sessions, with draggable layouts.
- Align task review-state displays and protect unsaved channel settings.
- Improve engine idle timeouts, local CLI discovery and credential isolation, desktop backend startup waits, and static-resource update recovery.
- Synchronize the website and complete five-language manual, and update the website build toolchain.

### Downloads and validation

Installers: `WorkStep-macos-arm64.dmg`, `WorkStep-macos-x64.dmg`, `WorkStep-windows-x64.exe`, and `WorkStep-linux-x64.AppImage`. Sandbox image: `ghcr.io/xzregg/workstep:v1.0.15`, for Linux amd64/arm64, pinned by digest in desktop packages. Packages are intentionally unsigned and not notarized. Desktop updates link to GitHub for manual installation.

[Source CI](https://github.com/xzregg/workstep/actions/runs/40489324989) and the [release workflow](https://github.com/xzregg/workstep/actions/runs/40495682551) passed. Windows installation, startup, persistence, upgrade, and uninstall acceptance passed 25 checks; Apple Silicon and Intel DMG acceptance passed 7 checks each. Installer hashes match the published checksum file and GitHub asset digests. Evidence is available in the workflow artifacts.

Sandbox image digest: `sha256:66138a8366816d2a63d0d1c7cd8175e020fe7d656388b0b2df8d20302da29048`.

Automation does not cover real Windows 10/11 SmartScreen or macOS Gatekeeper behavior, authenticated provider calls, Podman/WSL2 sandboxes, or live download handoff. The manual retains 13 registered screenshot gaps.

## 1.0.14

### Highlights

- Generate task drafts in batches with the task assistant and create multiple tasks from one schedule.
- Add Feishu/Lark application bots, group notifications, and gateway enterprise identity integration.
- Add Telegram, Discord, and Slack text channels with a dedicated bot configuration panel.
- Expand built-in languages: the application supports Simplified Chinese, Traditional Chinese, English, Japanese, German, French, and Arabic; the website supports Simplified Chinese, English, German, French, and Arabic. Some newly added application translations may still display Chinese, and application RTL layout is not supported.
- Improve task archival preparation, mobile task actions, sandbox storage management, product demonstrations, and the user manual.

### Downloads and validation

Installers: `WorkStep-macos-arm64.dmg`, `WorkStep-macos-x64.dmg`, `WorkStep-windows-x64.exe`, and `WorkStep-linux-x64.AppImage`. Sandbox image: `ghcr.io/xzregg/workstep:v1.0.14`, for Linux amd64/arm64, pinned by digest in desktop packages. Packages are intentionally unsigned and not notarized. Desktop settings check published versions daily and link to GitHub for manual installation; there is no automatic download, installation, or restart.

The release pipeline includes Windows installation/upgrade acceptance and native DMG acceptance for both Mac architectures. Automation does not cover authenticated LLM calls, real Windows 10/11 security warnings, or WSL2/Podman sandboxes. Building the Linux package is not clean-machine Linux desktop acceptance. Telegram, Discord, and Slack interactions use simulated tests; real tenant permissions and messaging remain unverified. Registered manual screenshot gaps remain.

## 0.1.0

Initial early-access release baseline: local projects, visual workflows, multiple LLM engines, task and chat execution, remote project sharing, scheduling, and desktop packaging.
