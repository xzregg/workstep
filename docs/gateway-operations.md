# Gateway 部署与恢复

本文记录单实例 Gateway 的部署步骤。发布验收状态以 [逐阶段计划](../plans/platform-gateway-development.md) 为准；完成本清单本身不代表端到端容量验收通过。

## 域名、TLS 与进程

1. 准备 `gateway.example.com` 与 `*.gateway.example.com` 的 DNS 记录，均指向同一反向代理。主域承载门户、公开任务分享及 `/api/control/ws`、`/api/data/ws`；`d-<device-id>.gateway.example.com` 承载设备工作台。反向代理必须保留原始 `Host`、HTTPS scheme、WebSocket Upgrade 及长连接，不应把设备子域改写为主域。
2. 为主域和设备通配符域名配置可信 TLS 证书。正式部署的浏览器与受管客户端使用 HTTPS/WSS；本机验收允许回环地址和 `.localhost` 使用 HTTP/WS，例如 `http://localhost:8700`，不允许非回环 HTTP。反向代理至 Gateway 的监听地址应仅在可信网络可达；Gateway 默认监听 `127.0.0.1:8766`。
3. 为服务进程设置持久数据目录和稳定配置：`WORKSTEP_GATEWAY_GATEWAY_ID`、`WORKSTEP_GATEWAY_PUBLIC_ORIGIN=https://gateway.example.com`、`WORKSTEP_GATEWAY_DATA_DIR`、`WORKSTEP_GATEWAY_WEB_DIST`、`WORKSTEP_GATEWAY_WORKSPACE_WEB_DIST`。数据库默认是数据目录下的 `workstep_platform.db`；使用 PostgreSQL 时设置 `WORKSTEP_GATEWAY_DATABASE_URL=postgresql+asyncpg://...`。门户先在 `apps/gateway-web` 执行 `yarn build`，将 `dist` 部署到 `WEB_DIST` 指向的位置；在 `apps/web` 执行 `yarn build:gateway-share`，将 `dist-gateway-share` 部署到 `WORKSPACE_WEB_DIST` 指向的位置，供公开分享复用原任务详情。
4. 在仓库根目录以服务管理器运行 `uv run --project apps/gateway uvicorn gateway.app:app --host 127.0.0.1 --port 8766`。保持单实例；启动时执行 Alembic 迁移，未知迁移版本或数据库不可用会拒绝启动。检查主域 `/api/health` 返回 `{"status":"ok"}`，再验证门户登录、设备控制连接和设备子域工作台。

反向代理应限制请求体大小并配置适合文件流和控制心跳的超时。不要将 daemon 的本机端口、数据库文件或设备直连地址暴露到公网。公开分享链接只使用 Gateway 主域。

## 备份与恢复

- SQLite：运行中的一致性备份使用 `uv run --project apps/gateway python apps/gateway/scripts/backup.py /安全位置/workstep_platform.db`。同时备份数据目录的 `gateway-signing-key.pem`、发布文件 `releases/` 及服务配置。备份文件和密钥应受独立访问控制。不要直接复制运行中的 SQLite 主文件作为在线备份。
- PostgreSQL：使用数据库自身的 `pg_dump` 或等价一致性备份，并同时备份上述签名密钥、发布文件和配置。恢复前确认数据库驱动、迁移版本及连接配置与备份匹配。
- 恢复时先停止 Gateway，恢复数据库及签名密钥到原配置的数据目录，核对 `GATEWAY_ID` 与 `PUBLIC_ORIGIN`，然后启动并检查健康、管理员登录、设备重连、已发布项目及分享。原数据库与新生成的签名密钥不可混用：受管包固定了公钥指纹，旧设备会拒绝新密钥。
- 升级前保存可回退的数据库与密钥配对快照。迁移执行后，旧程序未必能读取新 schema；回退程序时应先停机并恢复升级前的配对快照，再启动旧版本。恢复快照会丢失快照之后的平台写入，需在维护窗口明确处理。

## 密钥与受管客户端发布

`gateway-signing-key.pem` 是 Gateway 对授权、策略和分享内部票据签名的根密钥。当前受管包固定 Gateway 公钥指纹，服务没有无中断的双密钥轮换机制。常规升级和迁移应保留原密钥。确需更换时，安排维护窗口：停用旧包分发，生成新的 Gateway 密钥和匹配的新受管安装包，在新包上重新完成设备授权与审批，并逐台迁移；不得只替换服务端 PEM 后继续使用旧包。密钥疑似泄露时，应同时撤销相关设备授权和访问会话，并核查审计记录。

构建受管包时使用 `apps/desktop` 的 `yarn bundle:managed` 和 `yarn dist:managed`。构建环境提供 `WORKSTEP_GATEWAY_ID`、`WORKSTEP_GATEWAY_ORIGIN`、`WORKSTEP_GATEWAY_PUBLIC_KEY_FILE`、`WORKSTEP_MANAGED_SIGNING_KEY_FILE`、`WORKSTEP_MANAGED_BUNDLE_DIR`；包中 Gateway ID、主域和公钥必须与部署一致。按 [桌面发布清单](releasing.md)完成代码签名、校验和及干净机器验证，再把包放入 Gateway 数据目录 `releases/`，经管理员二次认证注册不可变版本和最低协议版本。先给试点设备安装，核对登录、控制心跳、项目访问及任务执行，再扩大分发。

回滚客户端时使用已登记且仍兼容当前 Gateway 协议的旧包；不要在旧包中修改受管配置或复用新版本的文件名。若服务端协议或数据库迁移已改变，先按上节恢复对应快照，再回滚客户端。设备被撤销或停用时，门户访问和数据通道应立即失效；运维人员应在设备页确认状态，并检查审计事件。
