"""Capture or verify a byte-for-byte baseline for the workflow engine and LLM adapters.

Run from any directory with --capture before work, then again without it.
The baseline may include pre-existing working-tree changes.
"""

from argparse import ArgumentParser
from hashlib import sha256
import json
from pathlib import Path


PROTECTED_PIPELINE = """
task_runner workflow_runtime workflow_definition workflow_start workflow_restart
workflow_recovery workflow_finalization workflow_lease workflow_limits
task_workflow_boundary workflow_hooks pipeline step_artifact_routes artifact_routing
artifact_rounds step_rework review_gate review_decision review_messages task_state
task_step_start step_execution_messages step_execution_config step_success_reuse
prompt concurrency task_workflow_config task_workflow
""".split()


def fingerprints():
    root = Path(__file__).resolve().parents[3]
    daemon = root / "apps" / "daemon"
    sources = list((daemon / "engines").rglob("*.py"))
    sources.extend(daemon / "services" / f"{name}.py" for name in PROTECTED_PIPELINE)
    return {path.relative_to(root).as_posix(): sha256(path.read_bytes()).hexdigest()
            for path in sorted(sources)}


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("--capture", action="store_true")
    args = parser.parse_args()
    actual = fingerprints()
    if args.capture:
        args.baseline.write_text(json.dumps(actual, indent=2), encoding="utf-8")
    else:
        expected = json.loads(args.baseline.read_text(encoding="utf-8"))
        changed = sorted(path for path in expected.keys() | actual.keys()
                         if expected.get(path) != actual.get(path))
        if changed:
            raise SystemExit("Protected workflow engine paths changed:\n" + "\n".join(changed))
        print(f"Workflow engine audit passed: {len(actual)} protected source files unchanged")


if __name__ == "__main__":
    main()
