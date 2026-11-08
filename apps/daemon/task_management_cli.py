"""Task lifecycle argument parsing and dispatch; business rules stay in the API."""

OPERATIONS = {
    "update": "workstep_update_task",
    "copy": "workstep_copy_task",
    "delete": "workstep_delete_task",
    "stop": "workstep_stop_task",
    "pause": "workstep_pause_task",
    "archive": "workstep_archive_task",
    "unarchive": "workstep_unarchive_task",
    "retry": "workstep_retry_task_message",
    "review-approve": "workstep_approve_task_review",
    "review-reject": "workstep_reject_task_review",
    "archive-draft": "workstep_get_archive_experience",
    "archive-prepare": "workstep_prepare_archive_experience",
    "archive-stop": "workstep_stop_archive_experience",
    "archive-confirm": "workstep_confirm_archive_experience",
}


def add_task_management_parsers(subparsers, add_json):
    for action in OPERATIONS:
        parser = subparsers.add_parser(action, help=action.replace("-", " "))
        parser.add_argument("--project", required=True, dest="project_id")
        parser.add_argument("--task", required=True, dest="task_id")
        if action in {"update", "copy"}:
            parser.add_argument("--title", required=action == "copy")
        if action == "update":
            parser.add_argument("--desc", dest="description", help="non-empty task description")
        if action == "delete":
            workspace = parser.add_mutually_exclusive_group()
            workspace.add_argument("--delete-workspace", dest="delete_workspace", action="store_true",
                                   help="also remove task worktrees; requires explicit authorization")
            workspace.add_argument("--keep-workspace", dest="delete_workspace", action="store_false")
            parser.set_defaults(delete_workspace=None)
        if action in {"retry", "archive-prepare", "archive-stop"}:
            parser.add_argument("--message", required=True, dest="message_id",
                                help="failed message ID, or stable draft UUID for prepare/poll/stop")
        if action in {"review-approve", "review-reject"}:
            parser.add_argument("--step", required=True, dest="step_key")
            parser.add_argument("--review", required=True, dest="review_run_id")
            parser.add_argument("--comment")
        if action in {"archive-prepare", "archive-confirm"}:
            parser.add_argument("--locale", help="output language, e.g. zh-CN or en-US")
        if action == "archive-confirm":
            parser.add_argument("--experience", required=True,
                                help="reviewed experience; empty only for a saved no-experience draft")
        add_json(parser)


async def dispatch_task_management(args, client):
    arguments = {"project_id": args.project_id, "task_id": args.task_id, "confirm": "yes"}
    for key in ("title", "description", "delete_workspace", "message_id", "step_key",
                "review_run_id", "comment", "locale", "experience"):
        value = getattr(args, key, None)
        if value is not None:
            arguments[key] = value
    if args.subcommand == "copy":
        arguments["newTitle"] = arguments.pop("title")
    return await client.call(OPERATIONS[args.subcommand], arguments)
