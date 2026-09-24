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


def test_source_entrypoint_preserves_click_installed_engine_sdks():
    start = (ROOT / "start.sh").read_text()

    assert 'uv run --no-sync uvicorn main:app' in start


def test_release_workflow_builds_unsigned_without_signing_secrets():
    workflow = (ROOT / ".github" / "workflows" / "desktop-release.yml").read_text()

    for secret_name in (
        "MAC_CSC_LINK",
        "MAC_CSC_KEY_PASSWORD",
        "APPLE_ID",
        "APPLE_APP_SPECIFIC_PASSWORD",
        "APPLE_TEAM_ID",
        "WIN_CSC_LINK",
        "WIN_CSC_KEY_PASSWORD",
    ):
        assert secret_name not in workflow

    assert 'CSC_IDENTITY_AUTO_DISCOVERY: "false"' in workflow
    assert "--config.mac.notarize=false" in workflow
    assert "--config.win.forceCodeSigning=false" in workflow
    assert "codesign --verify" not in workflow
    assert "Get-AuthenticodeSignature" not in workflow
    assert "actions/attest" not in workflow
    assert "attestations: write" not in workflow


def test_release_workflow_builds_windows_x64_and_x86_with_matching_python():
    workflow = (ROOT / ".github" / "workflows" / "desktop-release.yml").read_text()
    backend_builder = (ROOT / "apps" / "desktop" / "build-backend.ps1").read_text()

    assert "arch: x64" in workflow
    assert "python_arch: x86_64" in workflow
    assert "arch: ia32" in workflow
    assert "python_arch: x86" in workflow
    assert "WORKSTEP_WINDOWS_PYTHON_ARCH: ${{ matrix.python_arch }}" in workflow
    assert "--${{ matrix.arch }}" in workflow
    assert "desktop-windows-${{ matrix.arch }}" in workflow
    assert '"dist/WorkStep-windows-${{ matrix.arch }}.exe"' in workflow
    assert "$env:WORKSTEP_WINDOWS_PYTHON_ARCH" in backend_builder
    assert '"cpython-$PythonVersion-windows-$PythonArch-none"' in backend_builder


def test_release_publish_job_checks_out_tag_before_verification():
    workflow = (ROOT / ".github" / "workflows" / "desktop-release.yml").read_text()
    publish_job = workflow.split("  publish-draft:\n", 1)[1]

    assert "actions/checkout@" in publish_job
    assert 'ref: "${{ inputs.tag || github.ref }}"' in publish_job
    assert "gh release create" in publish_job
    assert "--verify-tag" in publish_job


def test_release_publish_job_refreshes_an_existing_draft_only():
    workflow = (ROOT / ".github" / "workflows" / "desktop-release.yml").read_text()
    publish_job = workflow.split("  publish-draft:\n", 1)[1]

    assert 'gh release view "$RELEASE_TAG" --json isDraft --jq .isDraft' in publish_job
    assert 'existing_release="$(gh release view' in publish_job
    assert 'if [ "$existing_release" = "true" ]; then' in publish_job
    assert 'gh release upload "$RELEASE_TAG" release/* --clobber' in publish_job
    assert 'gh release delete-asset "$RELEASE_TAG" builder-debug.yml --yes' in publish_job
    assert "gh release edit" not in publish_job
    assert '--target "$GITHUB_SHA"' not in publish_job
    assert 'elif [ "$existing_release" = "false" ]; then' in publish_job
    assert 'exit 1' in publish_job


def test_ci_runs_health_canaries_in_isolation_sensitive_stage():
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    daemon_stage, isolation_stage = workflow.split(
        "      - name: Isolation-sensitive daemon contracts\n", 1
    )

    assert "-k 'not does_not_block_health'" in daemon_stage
    assert "pytest -k does_not_block_health" in isolation_stage


def test_release_artifacts_exclude_electron_builder_debug_metadata():
    workflow = (ROOT / ".github" / "workflows" / "desktop-release.yml").read_text()

    assert "apps/desktop/dist/*.yml" not in workflow
    assert "apps/desktop/dist/latest-*-mac.yml" in workflow
    assert "apps/desktop/dist/latest-${{ matrix.arch }}.yml" in workflow
    assert "apps/desktop/dist/latest-linux.yml" in workflow
