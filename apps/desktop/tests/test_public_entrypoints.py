from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def test_start_script_does_not_kill_unrelated_port_owners():
    start = (ROOT / "start.sh").read_text()
    stop = (ROOT / "stop.sh").read_text()

    assert 'lsof -ti:"$port"' not in start
    assert 'lsof -ti:"$port"' not in stop
    assert 'fail "端口 $PORT 已被其他进程占用' in start


def test_source_entrypoint_uses_project_package_manager():
    start = (ROOT / "start.sh").read_text()

    assert "command -v corepack" in start
    assert "command -v yarn" in start
    assert "YARN_COMMAND=(corepack yarn)" in start
    assert "YARN_COMMAND=(yarn)" in start
    assert "run_yarn install --frozen-lockfile" in start
    assert "run_yarn build" in start
