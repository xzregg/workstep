# Project skill center

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
uv run --directory "$WORKSTEP_DAEMON_DIR" python -m cli <resource> <action>
```

Desktop-packaged engines can invoke the bundled CLI with:

```bash
"$WORKSTEP_CLI_PYTHON" "$WORKSTEP_DAEMON_DIR/cli.py" <resource> <action>
```

The packaged desktop backend includes `cli.py` beside the daemon sources and
uses its bundled Python runtime. `WorkstepClient` reads the live URL and adds
the temporary desktop token as a request header. PowerShell and `cmd.exe`
equivalents are documented in the skill. No global Python or `workstep`
installation is required on the user's machine.
