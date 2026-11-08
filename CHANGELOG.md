# Changelog

Notable user-facing changes are recorded here. WorkStep follows semantic versioning for tagged desktop releases.

## Unreleased

## 1.0.21

- Add a Weixin channel with QR-code authorization, image delivery and channel configuration controls.
- Support generated image attachments, task retry settings and task management through the local CLI.
- Add reusable Gateway user invitations and project-scoped workspace navigation, with per-project permission checks.
- Improve desktop sandbox configuration synchronization, startup diagnostics and shared searchable controls.
- Restrict filesystem preview access to the configured project directory and improve Android page recovery.
- Navigate between individually authorized projects on the same Gateway device without redeeming another ticket. Keep HTTP requests, WebSocket streams and sidebar actions scoped to each project's current permissions.
- Reuse searchable selection controls across the workspace and Gateway, and standardize navigation links and routine administration dialogs. Keep authentication, CSRF and sensitive-operation verification in place.
- Sync selected host engine configuration directories into a prepared desktop sandbox, with confirmation, backups and source-directory validation. Show compatibility guidance when the running desktop bridge needs a restart or update.
- Add flushed startup-stage diagnostics and retain redacted backend output on startup failure. Improve application-script failure detection and Gateway asset-cache recovery.
- Reorder desktop chat panes by dragging their headers, and distinguish user instructions from review output in task conversations.
- Preserve the required Git credential-handling source module in filtered release payloads while continuing to reject secret candidates in its contents.
- Filter temporary files, non-runtime plans, local configuration, databases and key files from release payloads. Validate first-party content during desktop and image builds and recheck injected desktop files before packaging; stop on secret candidates without printing their values.
- Improve Android failed-page recovery with native retry, cache reload, device-list and diagnostic actions. Summarize known console error signatures without recording arbitrary console content or URL credentials.
- Keep sidebar conversation titles and local directory selection compact, and move skin actions above their preview without changing execution permissions.
- Bundle the editable Interstellar Night skin and its credited local background asset. Seed it at startup without overwriting existing packages or restoring a skin the user removed; keep the default appearance and script settings unchanged.
- Update the appearance manual across all 26 supported languages, refresh real demonstration screenshots, and add a bilingual acceptable-use policy linked from the website and terms.
- Improve compact execution-status overflow using the shared marquee component and simplify the context-compaction indicator.
- Add a per-skin Run skin scripts switch in Appearance settings. Retain its setting across reloads and same-ID package updates; disable failed scripts without resetting the selected appearance. Enabled scripts have the current page's permissions and are not sandboxed.
- Refresh the selected installed skin on startup without overwriting personal font preferences, and allow applying an updated revision with the same skin ID.
- Simplify the skin studio header and creation guidance. Generate a unified skin.json package with theme.js, accepting an empty module when no scripted behavior is needed.
- Add official-site canonical metadata, social-preview cards, crawler files and a prerendered homepage that reuses the real application content while preserving browser interactivity.
- Reclaim mobile composer toolbar space when the send button is hidden, while preserving spacing around visible send and stop controls.
- Preserve mounted Gateway conversations and drafts through temporary connection failures while continuing to reject invalid or revoked sessions. Display business WebSocket round-trip latency using the existing heartbeat.
- Navigate Android notification destinations inside the mounted workspace where possible, retain direct device links and keep ordinary navigation as a fallback. Extend the Android page-load deadline to three minutes.
- Compact mobile message metadata and prompt labels while keeping full dates visible and long execution details horizontally accessible.

## 1.0.18

### Highlights

- Preserve the active project, workflow and conversation when expanding or collapsing sidebar project trees; open a different workflow or conversation only through its own entry.
- Reuse an already-open Android notification destination instead of reloading it, including Gateway device-scoped project links. Include the current project name in the native bridge to match workspace URLs correctly.
- Add a shared message-history page-size setting, with a default of 20 and a supported range of 1–300. Apply the saved value to new history requests without reloading an open conversation.
- Add activity-aware robot avatars, clearer task failure reasons and improved artifact-round navigation. Remove archived or deleted conversations from restored chat panes while preserving failed operations and unrelated sessions.
- Load project catalogs without workflow bodies, fetch selected workflow details on demand, and expose recoverable loading errors instead of treating unavailable definitions as empty workflows. Rename the current workflow from its task-panel title with validation, cancellation and retry.
- Add Gateway company branding, explicit administrator-only application-secret reveal, application enable/disable controls and selected permission revocation. Preserve CSRF checks, audit records, non-cacheable secret responses and a valid login method.
- Improve Gateway same-origin device entry, identity reuse across verified platform address aliases, shared data-connection recovery and bounded static-resource retries. Compress eligible static responses without buffering API event streams or double-compressing proxied assets.
- Allow authorized host workspaces to inspect cached system statistics while continuing to exclude project-scoped and shared visitors. Add an image-only Actions mode that validates service startup and persistence before updating the sandbox image's latest tag.
- Add local-only, one-click problem feedback in Settings. Desktop users can copy redacted diagnostic text, then explicitly preview and copy a screenshot of the current workspace. Browser users can copy bounded frontend diagnostics without reading backend files. Nothing is submitted automatically; screenshots require a separate privacy review.
- Summarize repeated diagnostic errors into a bounded, privacy-filtered report with key stack frames; keep full diagnostic export available. Improve feedback-window recovery and screenshot controls.
- Add a persistent automatic-update-check preference in desktop settings. Turning it off prevents background Release requests; explicit manual checks remain available.
- Preserve coordinator provenance in step instructions, live messages and persisted history while retaining the original initiating user. Improve archive-experience evidence filtering and bounded processing of long histories without writing Memory before confirmation.
- Enforce matching host permissions for engine configuration, stored-secret reveal and provider import; retain explicitly authenticated native workspace access and scoped cleanup of unused local provider credentials.
- Make manual review actionable only after its pending review record and step status are saved together; keep health checks responsive during slow review writes.
- Add workflow mode to ordinary local-project chat: insert the workflow skill reference, review a diagram and confirm before creating and starting work. Resolve same-project task links before opening task details; do not expose the entry in remote or embedded chats.
- Add per-conversation Codex CLI and SDK speed selection. Follow default, Standard, Fast and Ultrafast are forwarded per turn; actual availability depends on the runtime, provider, model and account.
- Add opt-in reuse of successful workflow steps when their accepted artifacts and configuration still match. Explicit reruns and coordinator-directed execution continue to run the selected step again.
- Improve multi-pane chat activation, reload recovery, compact shortcuts, pending-image previews, long-message folding, slash-command filtering and unanswered questions after a stopped reply.
- Reduce mobile chat-history page size while preserving pagination and scroll position. Improve mobile conversation creation, Git diff navigation and narrow-pane role controls.
- Refresh coordinator role boundaries on resumed turns, and retry transient streaming channel delivery failures before completion without changing final-delivery behavior.
- Keep host-scoped role, skin and language management independent of engine-install permission while preserving project-scoped remote restrictions. Improve LAN identity handling and remote-access failure recovery.
- Refresh the website onboarding links, support contact, skin workspace and gateway overview/recovery interfaces.

### Downloads and updates

Installers target Windows x64, macOS Apple Silicon and Intel, and Linux x64. Packages are intentionally unsigned and not notarized; operating-system security prompts remain possible. Daily update checks use published GitHub Releases, not branch pushes or draft releases. Download, installation and restart require an explicit user action; manual GitHub downloads remain available.

Sandbox image: `ghcr.io/xzregg/workstep:v1.0.18` and `latest`, for Linux amd64 and arm64. Desktop packages pin the image digest. Windows hosts require WSL2/Podman; this is not a native Windows container image.

### Validation boundaries

Publication requires passing source CI, Windows installer acceptance and both native macOS DMG acceptance jobs. Automated tests do not establish live-provider speed or execution, real messaging-tenant delivery, operating-system security-prompt behavior, live automatic upgrade/relaunch, or Podman/WSL2 acceptance. Diagnostic redaction is a safeguard, not a guarantee that copied text or screenshots contain no sensitive information. Review both before sharing. Existing manual guidance, translation and screenshot gaps remain recorded; design files under `plans/` are not shipped features. Historical tags and installer assets remain unchanged.

## 1.0.17

### Highlights

- Add explicit, click-to-install desktop updates with download progress, integrity checks and application restart. Keep daily checks against published GitHub Releases and the manual GitHub download option; pushing code or creating a draft does not offer an update.
- Show an update action in the desktop navigation rail and share update state with system settings. Windows NSIS and Linux AppImage use release update metadata; macOS uses an architecture-matched ZIP with SHA-256, bundle identity, version and signature-integrity checks. macOS ad-hoc signatures do not authenticate a Developer ID publisher.
- Localize built-in workflow templates and generated content, preserve existing user assets, and improve conversation role instructions, Codex capacity retries and planning-tool support.
- Add activity heatmaps, improve task step navigation and streamed text/video previews, and open Codex file citations through the shared file preview.
- Allow successful scheduled checks to produce no tasks without inventing work. Improve cancellation and shared gateway connection failure handling.
- Preserve sibling stages waiting for manual review when resuming after another stage is approved; do not execute them again or replace the pending review.
- Improve gateway user-group editing, last-login sorting, account usage and security settings, audit filters, device health details, and session recovery.
- Refresh the website and add localized narrated product introduction videos. Synchronize desktop-update instructions across all 26 website/manual languages.
- Correct release-contract tests to allow refreshing English notes on an existing draft while continuing to reject mutations to published releases.

### Downloads and updates

Installers are available for Windows x64, macOS Apple Silicon and Intel, and Linux x64. Packages are intentionally unsigned and not notarized; operating-system security prompts remain possible. Save edits and finish active work before clicking the update action. macOS updates require a writable installation directory, not a mounted DMG or App Translocation location. Other Linux installation formats retain manual downloads.

Sandbox image: `ghcr.io/xzregg/workstep:v1.0.17` and `latest`, for Linux amd64 and arm64. Desktop packages pin the image digest. Windows hosts require WSL2/Podman; this is not a native Windows container image.

### Validation boundaries

Publication requires passing source CI, Windows installer acceptance and both native macOS DMG acceptance jobs. Source/mock tests do not establish live-provider execution, operating-system security-prompt behavior, live automatic upgrade/relaunch, or Podman/WSL2 validation. Existing manual screenshot and guidance gaps remain explicitly recorded; prototype files under `plans/` are not shipped product features. Historical releases and installer assets remain unchanged.

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
