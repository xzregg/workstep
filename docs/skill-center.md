# Project skill center

本机项目设置 → 技能提供「聊天制作技能」。制作复用普通项目对话，所有会话统一在固定 `Runtime` 项目根目录工作，包目录由对话自行创建；CLI 为 `workstep skill create --json`。草稿目录不是技能扫描根，已安装技能库保持原位置，完成后经用户明确要求再安装。详见 [自定义草稿共享工作区](customization-workspace.md)。

WorkStep discovers filesystem skills from `~/.agents/skills`,
`~/.claude/skills`, and `~/.codex/skills`. Discovery is recursive, but stops at
the first directory containing `SKILL.md`; nested resources inside a skill are
not treated as separate skills.

WorkStep also ships built-in skills from `apps/daemon/data/skills/`. A newly
discovered built-in skill is enabled by default unless the project already has
an enabled skill with the same name. The built-in `workstep-cli` skill documents
the native `workstep_call` operations and their CLI equivalents. It is mirrored
to `<project>/.workstep/skills/workstep-cli/` on the first skill inspection or
engine launch. Users can disable it per project; an explicit disable is
preserved on later rescans and application upgrades.
The task coordinator uses the engine's native WorkStep tools or this enabled
skill; it does not append a separate copy of the CLI command manual to each
turn's prompt.

Selections are project-scoped. `services/skill_center.py` owns discovery,
validation, duplicate-name selection, safe mirroring, and the manifest at
`<project>/.workstep/skills/.workstep-manifest.json`. Engines must consume
`SkillCenter.runtime_selection()` and must not scan personal roots themselves.
Enabled sources are copied atomically into `<project>/.workstep/skills`; missing
or unsafe sources fail closed. Existing project skills are adopted without
being overwritten and are moved to `.workstep/skills-disabled` when disabled.

The REST surface is:

- `GET /api/skills?project_id=...`
- `POST /api/skills/rescan?project_id=...`
- `PUT /api/skills/projects/{project_id}` with `{skill_id, enabled}`

Each engine declares a `skill_policy`. Codex receives `skills.config` overrides
and a generated project-local `.agents/skills` projection because
`skills.config` filters discovered skills but does not add a discovery root;
Claude and Qoder receive generated local plugins and explicit allowlists;
Hermes runs with an isolated `HERMES_HOME`; OpenClaw receives a generated config;
DeepSeek Harness receives a derived filesystem-provider composition; Pydantic AI
reads only the managed `.workstep/skills` mirror. An adapter without a strict
policy reports controlled skills as unsupported.

## Engine loading matrix

`.workstep/skills/` is the canonical project-level source consumed by every
supported adapter. Engine-specific runtime projections such as Codex's
`.agents/skills/<skill-name>` directories are disposable, WorkStep-owned
copies; user-owned skill directories are preserved.

| Engine | How enabled project skills are loaded |
|---|---|
| Codex CLI | Materializes enabled skills in `.agents/skills/<skill-name>`, reuses copies whose relative file list and sizes match, then passes `skills.config` for enable/disable filtering. |
| Codex SDK | Uses the same size-checked, discoverable project projection and passes the generated `skills.config` to the SDK client. |
| Claude Code | Builds `.workstep/runtime/claude-plugin` and enables its `workstep:<skill>` names through `skillOverrides`. |
| Claude Agent SDK | Uses the same generated Claude plugin and explicit allowlist. |
| Qoder SDK | Builds `.workstep/runtime/qoder-plugin` and passes the enabled skill names to the SDK. |
| Hermes ACP | Builds an isolated runtime `HERMES_HOME`, copies only enabled skills, and preloads their names with `--skills`. |
| OpenClaw | Writes `.workstep/runtime/openclaw/openclaw.json` with the managed directory and enabled names. |
| DeepSeek Harness | Derives a project-local composition with default roots disabled and `.workstep/skills` as its only custom skill directory. |
| Pydantic AI | Attaches the harness `Skills` capability directly to the managed `.workstep/skills` directory. |

An engine with `skill_policy=unsupported` does not receive project skills. This
is fail-closed: adapters must add an explicit projection before claiming skill
support.

## WorkStep CLI runtime

The `workstep-cli` skill never persists the daemon URL or desktop token. The
daemon exports `WORKSTEP_DAEMON_URL`, `WORKSTEP_DESKTOP_TOKEN`,
`WORKSTEP_CLI_PYTHON`, and `WORKSTEP_DAEMON_DIR` to engine processes. Restricted
source engines should use the commonly allowed `uv` entry point without first
probing `pwd`, `echo`, or a global `workstep` installation:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli <resource> <action>
```

Desktop-packaged engines can invoke the bundled CLI with:

```bash
"$WORKSTEP_CLI_PYTHON" "$WORKSTEP_DAEMON_DIR/cli.py" <resource> <action>
```

The packaged desktop backend includes `cli.py` beside the daemon sources and
uses its bundled Python runtime. `WorkstepClient` reads the live URL and adds
the temporary desktop token only for that daemon's local origin. Local CLI
does not require platform login or a manually supplied token, even in Gateway
mode. At startup the daemon publishes a per-launch record under the user's
configuration directory `cli-runtime/`, scoped by local origin. The client
discovers it in a worker thread; POSIX ownership/modes and Windows owner-private
ACLs protect it. It is not project data and must never be copied into skills,
commits, prompts, logs, or remote requests. Shutdown removes this launch's
record, not a replacement daemon's record.

The trusted local path requires loopback peer and host and rejects browser
Origin, Fetch Metadata, forwarded headers, and remote Gateway actor scopes.
Public HTTP, browser login, remote invitations, and Gateway permissions retain
their checks. Remote project forwarding strips local credentials. Restart an
older running daemon once after upgrading; replacing the CLI alone does not
change the server's authorization policy. PowerShell and `cmd.exe`
equivalents are documented in the skill. No global Python or `workstep`
installation is required on the user's machine.
