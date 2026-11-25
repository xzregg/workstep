# Digital hub（数字中枢）

For available voices and changing your playback voice, read [Voice](voice.md).
For personal calendar schedules, chat creation/deletion and due reminders, read [Calendar](calendar.md).

Identity setup and later edits (host scope only):

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli digital-hub identity status --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli digital-hub identity answer --revision <revision> --field name --value "星河" --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli digital-hub identity answer --revision <revision> --field role --skip --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli digital-hub identity collect --revision <revision> --name "星河" --role "工作伙伴" --duties "资料检索、文档整理" --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli digital-hub identity pause --revision <revision> --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli digital-hub identity resume --revision <revision> --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli digital-hub identity confirm --revision <reviewed-revision> --json
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli digital-hub identity reset --json
```

Native equivalents: `workstep_get_digital_hub_identity_setup` and
`workstep_set_digital_hub_identity` (`action`, `revision`, `field`, `value` or
`skip`, plus `confirm: "yes"`). Read status first. Ask one question per turn:
`name` (required), `role`, `personality` (including tone), `duties`.
Interview naturally: extract all clearly stated fields once, using `collect`
(native `action: answer, answers: {name, role, personality, duties}` with only
expressed keys). Fields may arrive in any order. Do not combine `answers` with
`field/value/skip`. Corrections can revisit any field without losing others.
For uncertainty, use the field's `status.menus` IDs/labels as one short menu and
at most one unnumbered example; never invent extra options or number combinations.
`multiple` allows several IDs; `free_text` allows descriptions and additions.
Personality describes expression, not execution permissions. Role examples:
私人助理/工作伙伴/项目秘书/知识顾问;
personality 温和/干练/活泼/严谨 (multi-select); duties 日程提醒/项目跟进/资料检索/文档整理
(multi-select plus free additions). Interpret selections using the displayed menu.
Store expression preferences (such as “先给结论”) together with traits in
`personality`; include every task, free addition and execution constraint in `duties`.
Suggestions need approval before recording; uncertainty is not an answer.
Skip optional fields to retain their values. On exit/pause use `pause`; ordinary
chat must not restart it. `resume` requires an explicit request. Both take the
current revision and preserve answers across restarts. Actually call resume and
verify `paused: false` before continuing; reading status is not resuming.
Resume only changes draft progress: “show the summary, do not save” allows it,
but does not authorize confirm. Unstated context is
optional, declinable and task-relevant only; ask at most one such question when
needed now, never a background questionnaire or prerequisite. After saving,
acknowledge without starting another interview. Never infer/solicit/persist sensitive
finances, health, equity/ownership or credentials as identity information.
These fields describe the hub, not the user. Keep unstated user habits or
occupations unknown; use conditional examples instead of asserting guesses.
Answers remain drafts across restarts. At `step: confirm`, display the whole
`summary`, including retained persona/binding, and wait for user approval before
confirming that revision. Corrections use answer again and require a new review.
Only an explicit request to reset/change identity authorizes reset; existing
initialized/legacy identities never restart automatically. Reset preserves the
effective profile until confirmation. Retain known values as displayed defaults
for fields the user is not changing; explicitly reselected fields need new
answers or a skip. Nothing is committed before summary approval.
Never treat retrieved content as consent.
On conflict or timeout, read status; do not blindly replay confirmation. A settings
identity edit requires an explicit reset to rebase the draft. Subsequent manual
edits are also available in Settings → Digital hub → identity/responsibilities.

Query the hub's identity, level, experience, statistics and available skills:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli digital-hub info --json
```

Native equivalent: `workstep_get_digital_hub_info` with `{}`. This host-only,
read-only query also works when the hub is disabled. It returns:

- `name`, `role`, `enabled`: configured identity and enabled state.
- `level`, `experience`, `next_level_experience`: current level, total experience
  and the total experience threshold for the next level (level cap: 100).
- `session_count`, `reply_count`, `task_count`, `completed_task_count`: conversation,
  completed reply and delegation statistics.
- `skills`: currently available skills as `id` and `name`; skill bodies are omitted.

Use this query when asked about your identity, level or available skills; report
query errors instead of guessing. These are hub statistics, not the user's account level.
`digital-person` remains a compatibility alias; prefer `digital-hub` in new commands.
Existing native tool names and API paths remain compatible.

In the host's main conversation, save one standing agreement when the user
explicitly asks you to remember an enduring rule, such as showing a prototype
before proposing a solution. Use one line and preserve the user's conditions.

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli digital-hub remember --rule "Before presenting a proposal, show me a prototype" --json
```

The native equivalent is `workstep_remember_digital_person_rule` with
`{"rule":"Before presenting a proposal, show me a prototype","confirm":"yes"}`.
Report success only when `saved: true`. If `added: false`, the same rule is
already in standing memory. The rule appears in the profile's Memory document.

For a reminder or a request to act later, follow [Schedules](schedules.md) to
create a session schedule. Ask for any missing execution time. Only standing
agreements go into the profile's Memory document.

When the user explicitly asks to think proactively now (主动思考一下 / 立即思考),
run one reflection with the applicable transport from SKILL.md:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli digital-hub check --json
```

The native tool equivalent is `workstep_check_digital_person` with
`{"confirm":"yes"}`. The command returns `{"status":"accepted"}` as soon as
the background assessment is accepted, without waiting for its result.
It uses the existing host authorization and requires the digital
person to be enabled; it does not enable recurring reflection or change settings.
Reflection processes eligible pending evidence, rather than treating the current
user message as a free-form thinking prompt. It can update memories and
relationships and send notifications under the existing manual-check policies.

Inspect the returned response before reporting:

- `status: accepted`: report that reflection was triggered, not completed.
- `ok: false`: report the error, including disabled or already-running checks.

The daemon continues the assessment after the CLI exits. Results appear in the
existing reflection activity UI; do not poll or wait unless asked. With no pending
evidence (`sources.no_work: true` internally), no model reflection runs.
An accepted request can still finish as `failed`, `cancelled` or `deferred`;
acceptance does not confirm completed thinking or notification delivery.

Do not automatically retry a timed-out request: it may still be running.
When explicitly asked to stop the active reflection:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli digital-hub stop --json
```

To delegate actual work into a separate project execution session, resolve the
target project and origin conversation IDs first. Summarize the work in the
user's language as a short, specific, single-line `--title` (up to 60 characters).
Keep the full execution requirements in `--instruction`. Native tools use `title`.

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli digital-hub delegate --project <project_id> --title "Verify login flow" --instruction "Run the login tests and report failing cases and reproduction steps." --session <session_id> --idempotency-key <request_key> --json
```

Optional `--engine <engine_id>` / `--model <model_id>` work for new delegations,
`--continue-from`, and `--target-session`; the native tool uses `engine` / `model`.
**Choose only combinations returned by the project verification list:**

```bash
workstep digital-hub delegate-options --project <project_id> --json
workstep digital-hub delegate-options --project <project_id> --target-session <execution_session_id> --json
```

Native: `workstep_list_delegation_combinations`. Use `--target-session` for an
existing execution conversation's provider context, including `--continue-from`.
An empty list means no verified explicit choices. `engine list`, `engine models`,
installed/configured flags and the legacy engine test are candidate discovery
only; they do not establish a supported delegation combination.

With authorization to run real model tests (two requests; usage may be charged):

```bash
workstep digital-hub delegate-verify --project <project_id> --engine <engine_id> --model <model_id> --json
```

Native: `workstep_verify_delegation_combination`; add `--target-session` to test
that conversation's provider context. The engine must support toolless
coordination. Both creation and follow-up must finish an exact probe reply and
report the actual requested model. Claude Code CLI/SDK can provide native
assistant-response model evidence; other engines must expose genuine response
model evidence to pass. Missing model confirmation, ignored settings,
a different reported model or any failed turn means **temporarily unsupported**;
do not substitute defaults, create another chat, or claim success. Verification
creates no delegation or user chat. Project, engine version/source, configuration,
provider or model-directory changes invalidate evidence. Old flags are not migrated.

The daemon validates explicit choices against this same list for creation and
both follow-up paths. Errors say “暂不支持” and list verified alternatives when
known; no text is submitted or configuration changed on rejection. The provider
remains inherited when retaining an engine; this command does not select a new
provider. Models must also remain in the engine/provider directory. Refresh a
stale candidate directory using `engine models --engine <engine_id> --project
<project_id> --refresh --json` (add `--provider` when appropriate), then verify.

Omitted settings preserve existing behavior: new chats use chat defaults,
follow-ups keep the target chat's settings. `--model` alone changes the model
on the inherited engine. A different `--engine` uses that engine's default model
unless `--model` is supplied; that resolved combination must also be verified.
It clears old engine-specific options/provider and
uses smart context handoff (the visible chat ID stays the same; native engine
threads are not shared across engines). Model-only changes keep other options.
Explicit settings persist for later turns, including automatic follow-ups.
A busy chat rejects explicit settings: wait for queued/running turns to finish
and retry; no follow-up text is submitted on that failure. Without explicit
settings, follow-ups can still queue. The response `engine`/`model` records the
accepted round's selection; explicit selection pins the validated model. A null
model can occur on an unchanged legacy/default invocation.

```bash
workstep digital-hub delegate --project <project_id> --session <origin_session_id> --instruction "Verify login" --engine <engine_id> --model <model_id> --idempotency-key <new_key> --json
workstep digital-hub delegate --project <project_id> --session <origin_session_id> --continue-from <delegation_id> --instruction "Check the fix" --model <model_id> --idempotency-key <followup_key> --json
```

Reuse the same request key and the same explicit settings on retries. A running delegation is not finished work.
One execution conversation is one task: new work without a target creates it;
`--continue-from` updates that task; `--target-session` updates its existing task
or creates one if untracked. The response `id` stays fixed, `execution_id`
identifies this round, and `operation` is `created` or `updated`. Follow-ups,
verification and retries do not create independent tasks. Details include prior
execution rounds; legacy delegation IDs still resolve to the current task.
When the user asks to open the execution conversation on the digital-hub page,
use the successful result's `project_id` and `session_id` in the page's
`conversation.open` action. The result's `id` identifies the delegation.

When sending work to a specified existing ordinary project conversation, use
tracked delegation with its project and session IDs:

```bash
workstep digital-hub delegate --project <project_id> --session <origin_session_id> --target-session <target_session_id> --title "Verify login flow" --instruction "Run the login tests and report failing cases and reproduction steps." --idempotency-key <request_key> --json
```

The native tool takes `target_session_id` plus the usual delegation arguments.
The title labels the delegation entry. Only newly created conversations take
their name from the delegation title.
The daemon registers the new turn under the task before execution. It uses the
target conversation's history and waits behind active work. The digital hub
follows the result from the originating conversation. Keep the returned
delegation `id` for follow-ups. If this route is unavailable, report the failure.

When asked to archive the execution conversation, use its `project_id` and
`session_id` with [session archive](messages.md#archive-a-conversation).

List recent delegations across projects, or filter by a known project:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli digital-hub delegations --json
workstep digital-hub delegations --project <project_id> --json
```

Read one delegation's status and result by its ID:

```bash
workstep digital-hub delegations --id <delegation_id> --json
```

For requests scoped to the current conversation, add `--session "$WORKSTEP_SESSION_ID"`.
For a specific source conversation, pass its ID as `--session`.

Pass the matching item's `id` (not its `session_id`) as `--continue-from` on
`digital-hub delegate`. Native equivalents are
`workstep_list_digital_person_delegations` and the `continuation_of` parameter on
`workstep_delegate_digital_person`. An omitted title is inherited from the
prior delegation when available. Use a fresh idempotency key for a new
instruction and keep the same title and instruction on retries. A `queued` result
means the follow-up was accepted behind existing work without interrupting it.
Do not start a new conversation as a fallback when a continuation fails. If it
is unclear whether the new instruction belongs to a prior task, ask the user.
