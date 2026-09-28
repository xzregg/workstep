# Gateway 开发与部署

Gateway 是独立 FastAPI 服务，`apps/gateway-web` 是独立门户。当前只完成阶段 0 骨架，尚无登录、设备连接或平台授权能力；部署验收以 `plans/platform-gateway-development.md` 为准。

本地开发使用 `uv run --project apps/gateway --group dev uvicorn gateway.app:app --host 127.0.0.1 --port 8766`。门户在 `apps/gateway-web` 执行 `yarn dev`，开发服务器将 `/api` 代理到 8766。构建后可设置 `WORKSTEP_GATEWAY_WEB_DIST` 为门户 `dist` 的绝对路径，让 Gateway 托管静态文件。默认数据目录为 `~/.workstep-gateway`，可用 `WORKSTEP_GATEWAY_DATA_DIR` 指定；阶段 1 将接入数据库。

生产环境应为 Gateway 提供独立 HTTPS 域名。阶段 3C 的设备子域代理需要 `d-<device-id>.<gateway-domain>` 的通配符 DNS 和 TLS；当前骨架尚不提供该代理，不应作为受管平台对外部署。

测试：`uv run --project apps/gateway --group dev pytest apps/gateway/tests packages/gateway-protocol/tests`；协议模型变更后运行 `uv run --project apps/gateway python packages/gateway-protocol/scripts/schema.py` 并提交 `schema.json`。门户在 `apps/gateway-web` 运行 `yarn test && yarn build`。
