# Project skill center

WorkStep discovers filesystem skills from `~/.agents/skills`,
`~/.claude/skills`, and `~/.codex/skills`. Discovery is recursive, but stops at
the first directory containing `SKILL.md`; nested resources inside a skill are
not treated as separate skills.

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

Each engine declares a `skill_policy`. Codex receives `skills.config` overrides;
Claude and Qoder receive generated local plugins and explicit allowlists;
Hermes runs with an isolated `HERMES_HOME`; OpenClaw receives a generated config;
DeepSeek Harness receives a derived filesystem-provider composition; Pydantic AI
reads only the managed `.workstep/skills` mirror. An adapter without a strict
policy reports controlled skills as unsupported.

