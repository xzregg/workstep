# Architecture

WorkStep is a local-first system with three distributable surfaces: `apps/daemon` is the Python/FastAPI orchestration and persistence service; `apps/web` is the React/TypeScript application; `apps/desktop` is an Electron shell that starts a Nuitka standalone daemon sidecar. The sidecar binds only to `127.0.0.1`, uses port `0` by default, and reports the operating-system-selected port through the `PORT:<port>` stdout protocol. The marketing site is in `apps/landing`, while early static prototypes remain in `ui`.

## Data ownership

Each project stores state in `.workstep/workstep.db`; no hosted account is required. Tasks, task steps, messages, engine sessions, and artifacts are project-local. Engine events are normalized before persistence so live streaming and historical replay share the same AG-UI translation.

## Engine boundary

`BaseLLMEngine` defines WorkStep-specific discovery, installation, configuration, and capabilities. `AcpEngineBase` defines the common session, interaction, approval, and cancellation seam. Native ACP engines use it directly; SDK and CLI engines adapt only events they genuinely receive.

Qoder is optional and user-installed. Its SDK is not part of the default daemon, Docker image, or desktop bundle; installation requires explicit acknowledgement of Qoder's separate service terms.

## Event flow

Engines emit internal ACP-aligned events. Orchestration adds lifecycle events such as status, interactions, subagents, and errors. One translation layer maps both live and replayed events to AG-UI, which is the only format frontend stores consume.

WebSocket clients may subscribe by task, session, status-only task, or assistant channel. Filtering occurs before queue insertion while preserving legacy full broadcasts for older clients.

## Deep links and remote sharing

`workstep://open` opens the installed local application. A `workstep://remote-project/v1/...` invitation is validated and forwarded to the local UI as opaque data. Exact current interfaces and invariants remain documented in code and [`AGENTS.md`](../AGENTS.md).
