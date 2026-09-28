import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from workstep_gateway_protocol import PROTOCOL_VERSION

from .config import GatewaySettings
from .database import GatewayDatabase
from .identity_api import router as identity_router
from .external_identity_api import router as external_identity_router
from .identity_connectors import DingTalkConnector, WeComConnector
from .rate_limit import IdentityRateLimiter
from .reconciliation import DirectoryReconciler


def create_app(settings: GatewaySettings | None = None) -> FastAPI:
    settings = settings or GatewaySettings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        database = GatewayDatabase(settings)
        await database.start()
        app.state.database = database
        app.state.ready = True
        stop_reconciliation = asyncio.Event()
        reconciler = DirectoryReconciler(database, app.state.identity_connectors)
        app.state.directory_reconciler = reconciler
        reconciliation_task = asyncio.create_task(reconciler.run_periodic(
            stop_reconciliation, interval_seconds=settings.directory_reconcile_seconds,
        ))
        try:
            yield
        finally:
            app.state.ready = False
            stop_reconciliation.set()
            await reconciliation_task
            await database.close()

    app = FastAPI(title="WorkStep Gateway", lifespan=lifespan)
    app.state.ready = False
    app.state.settings = settings
    app.state.protocol_version = PROTOCOL_VERSION
    app.state.identity_rate_limiter = IdentityRateLimiter()
    app.state.identity_connectors = {"dingtalk": DingTalkConnector(), "wecom": WeComConnector()}

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, exc: HTTPException) -> JSONResponse:
        code = "not_found" if exc.status_code == 404 else "http_error"
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": code, "message": str(exc.detail)}},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, _exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"error": {"code": "validation_error", "message": "Invalid request"}},
        )

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(identity_router)
    app.include_router(external_identity_router)

    if settings.web_dist and settings.web_dist.is_dir():
        assets = settings.web_dist / "assets"
        if assets.is_dir():
            app.mount("/assets", StaticFiles(directory=assets), name="gateway-assets")

        @app.get("/{path:path}", include_in_schema=False)
        async def portal(path: str) -> FileResponse:
            if path.startswith("api/") or "." in path:
                raise HTTPException(status_code=404)
            return FileResponse(settings.web_dist / "index.html")
    return app


app = create_app()
