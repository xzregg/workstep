# Gateway 开发与部署

Gateway 是独立 FastAPI 服务，`apps/gateway-web` 是独立门户。阶段 0、1 已完成；尚无登录、设备连接或平台授权能力。部署验收以 `plans/platform-gateway-development.md` 为准。

本地开发使用 `uv run --project apps/gateway --group dev uvicorn gateway.app:app --host 127.0.0.1 --port 8766`。门户在 `apps/gateway-web` 执行 `yarn dev`，开发服务器将 `/api` 代理到 8766。构建后可设置 `WORKSTEP_GATEWAY_WEB_DIST` 为门户 `dist` 的绝对路径，让 Gateway 托管静态文件。默认 SQLite 位于 `~/.workstep-gateway/workstep_platform.db`，可用 `WORKSTEP_GATEWAY_DATA_DIR` 指定数据目录，或用 `WORKSTEP_GATEWAY_DATABASE_URL` 指定 `sqlite+aiosqlite` / `postgresql+asyncpg` 地址。启动执行 Alembic 迁移，未知版本拒绝启动，不会自动退回别的数据库。

SQLite 可在服务运行时执行 `uv run --project apps/gateway python apps/gateway/scripts/backup.py /安全位置/backup.db` 创建一致性备份；PostgreSQL 使用 `pg_dump`。数据库切换必须停机备份、迁移和校验。受管包可用 `apps/desktop` 的 `yarn bundle:managed` 生成签名配置，再用 `yarn dist:managed` 构建；前者需要 `WORKSTEP_GATEWAY_ID`、`WORKSTEP_GATEWAY_ORIGIN`、`WORKSTEP_GATEWAY_PUBLIC_KEY_FILE`、`WORKSTEP_MANAGED_SIGNING_KEY_FILE` 和 `WORKSTEP_MANAGED_BUNDLE_DIR`，后者需要最后一个变量。签名私钥只用于构建，不进入安装包。阶段 1 的受管设备实际连接仍待阶段 3B。

生产环境应为 Gateway 提供独立 HTTPS 域名。阶段 3C 的设备子域代理需要 `d-<device-id>.<gateway-domain>` 的通配符 DNS 和 TLS；当前骨架尚不提供该代理，不应作为受管平台对外部署。

测试：`uv run --project apps/gateway --group dev pytest apps/gateway/tests packages/gateway-protocol/tests`；协议模型变更后运行 `uv run --project apps/gateway python packages/gateway-protocol/scripts/schema.py` 并提交 `schema.json`。门户在 `apps/gateway-web` 运行 `yarn test && yarn build`。
