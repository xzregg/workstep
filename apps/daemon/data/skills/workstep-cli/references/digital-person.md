# Digital person

In the host's main conversation, save one standing agreement when the user
explicitly asks you to remember an enduring rule, such as showing a prototype
before proposing a solution. Use one line and preserve the user's conditions.

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli digital-person remember --rule "Before presenting a proposal, show me a prototype" --json
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
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli digital-person check --json
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
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli digital-person stop --json
```

To delegate actual work into a separate project execution session, resolve the
target project and origin conversation IDs first. Summarize the work in the
user's language as a short, specific, single-line `--title` (up to 60 characters).
Keep the full execution requirements in `--instruction`. Native tools use `title`.

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli digital-person delegate --project <project_id> --title "Verify login flow" --instruction "Run the login tests and report failing cases and reproduction steps." --session <session_id> --idempotency-key <request_key> --json
```

Reuse the same request key on retries. A running delegation is not finished work.
When the user asks to open the execution conversation on the digital-person page,
use the successful result's `project_id` and `session_id` in the page's
`conversation.open` action. The result's `id` identifies the delegation.

When sending work to a specified existing ordinary project conversation, use
tracked delegation with its project and session IDs:

```bash
workstep digital-person delegate --project <project_id> --session <origin_session_id> --target-session <target_session_id> --title "Verify login flow" --instruction "Run the login tests and report failing cases and reproduction steps." --idempotency-key <request_key> --json
```

The native tool takes `target_session_id` plus the usual delegation arguments.
The title labels the delegation entry. Only newly created conversations take
their name from the delegation title.
The daemon registers the new turn as a delegation before execution. It uses the
target conversation's history and waits behind active work. The digital person
follows the result from the originating conversation. Keep the returned
delegation `id` for follow-ups. If this route is unavailable, report the failure.

When asked to archive the execution conversation, use its `project_id` and
`session_id` with [session archive](messages.md#archive-a-conversation).

List recent delegations across projects, or filter by a known project:

```bash
uv run --no-sync --directory "$WORKSTEP_DAEMON_DIR" python -m cli digital-person delegations --json
workstep digital-person delegations --project <project_id> --json
```

Read one delegation's status and result by its ID:

```bash
workstep digital-person delegations --id <delegation_id> --json
```

For requests scoped to the current conversation, add `--session "$WORKSTEP_SESSION_ID"`.
For a specific source conversation, pass its ID as `--session`.

Pass the matching item's `id` (not its `session_id`) as `--continue-from` on
`digital-person delegate`. Native equivalents are
`workstep_list_digital_person_delegations` and the `continuation_of` parameter on
`workstep_delegate_digital_person`. An omitted title is inherited from the
prior delegation when available. Use a fresh idempotency key for a new
instruction and keep the same title and instruction on retries. A `queued` result
means the follow-up was accepted behind existing work without interrupting it.
Do not start a new conversation as a fallback when a continuation fails. If it
is unclear whether the new instruction belongs to a prior task, ask the user.
