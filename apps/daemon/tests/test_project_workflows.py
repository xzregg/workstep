"""Project workflow lifecycle is owned by its repository module."""

from unittest.mock import patch

from services.config import ConfigStore
from services.project import ProjectManager
from services.project_workflows import ProjectWorkflowService


def test_workflow_service_creates_updates_and_restores_project_flow(tmp_path):
    config_dir = tmp_path / ".workstep"
    config_dir.mkdir()
    manager = ProjectManager()
    with patch("services.config.CONFIG_DIR", config_dir), patch(
        "services.config.CONFIG_FILE", config_dir / "config.json"
    ), patch("services.project.config_store", ConfigStore()):
        try:
            project = manager.init_project(tmp_path)
            service = ProjectWorkflowService()
            with manager.activate_project_by_id(project.id):
                workflow = service.create_workflow(project, "初始流程")
                assert workflow["steps"] == {"nodes": [], "connections": []}
                updated = service.update_workflow(project, workflow["id"], name="更新流程")
                assert updated["name"] == "更新流程"
                service.create_workflow(project, "保留流程")
                assert service.delete_workflow(project, workflow["id"]) == {
                    "deleted": True, "soft": True,
                }
                assert service.restore_workflow(project, workflow["id"])["name"] == "更新流程"
        finally:
            manager.close_all()
