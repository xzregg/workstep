"""Workflow list reordering — sort_order schema support."""


def test_workflows_table_has_sort_order_column(tmp_path):
    """New project databases carry the workflow sort_order column."""
    from models import LATEST_SCHEMA_VERSION, SchemaVersion, init_db

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        assert SchemaVersion.get_by_id(1).version == LATEST_SCHEMA_VERSION
        columns = {column.name for column in db.get_columns("workflows")}
        assert "sort_order" in columns
    finally:
        db.close()


def test_workflow_sort_order_is_persisted(tmp_path):
    """Workflow rows store their sort_order and load back in that order."""
    import json

    from models import Workflow, init_db
    from models.fields import utc_now

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        now = utc_now()
        for index, name in enumerate(["First", "Second", "Third"]):
            Workflow.create(
                id=name,
                name=name,
                steps_json=json.dumps({"nodes": [], "connections": []}),
                is_default=index == 0,
                created_at=now,
                updated_at=now,
                sort_order=index,
            )
        rows = list(Workflow.select().order_by(Workflow.sort_order))
        assert [row.name for row in rows] == ["First", "Second", "Third"]
    finally:
        db.close()
