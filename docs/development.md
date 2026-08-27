# Development guide

## Setup

```bash
cd apps/daemon
uv sync --dev
uv run uvicorn main:app --reload --port 8765
```

```bash
cd apps/web
npm ci
npm run dev
```

The public landing page is in `apps/landing` and uses Yarn. Do not commit generated builds, local databases, logs, secrets, or personal configuration.

## Verification

```bash
cd apps/daemon && uv run pytest
cd apps/web && npm test && npm run build
cd apps/landing && yarn test && yarn build
python scripts/check_repository_health.py
```

Behavior changes should begin with a failing regression test. Frontend strings must exist in every locale with identical, non-empty key sets. New assistant capabilities reuse the shared runtime, stores, event channels, and chat components. Native `alert` and `confirm` are not used. Qoder stays optional and must not enter default, container, or desktop dependencies.

See [`AGENTS.md`](../AGENTS.md) for detailed agent-facing rules and [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the external contribution flow.
