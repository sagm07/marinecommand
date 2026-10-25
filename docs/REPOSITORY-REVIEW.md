# GitHub repository review and engineering choices

Reviewed upstream repositories and used their documented behavior as implementation references. No source code was copied wholesale.

| Repository | What was reviewed | Applied decision |
| --- | --- | --- |
| [MagicStack/asyncpg](https://github.com/MagicStack/asyncpg) | `add_listener` callback contract and async callback support in [connection.py](https://github.com/MagicStack/asyncpg/blob/master/asyncpg/connection.py) | Keep one dedicated connection for `LISTEN`; use a coroutine callback; keep query pool separate. |
| [fastapi/fastapi](https://github.com/fastapi/fastapi) | [WebSocket guidance](https://github.com/fastapi/fastapi/blob/master/docs/en/docs/advanced/websockets.md), disconnect handling, single-process caveat, and [lifespan lifecycle](https://github.com/fastapi/fastapi/blob/master/docs/en/docs/advanced/events.md) | Make listener startup/shutdown part of lifespan, gate readiness on LISTEN, and avoid presenting an in-memory list as a multi-worker event store. |
| [postgres/postgres](https://github.com/postgres/postgres) | PostgreSQL's [NOTIFY implementation](https://github.com/postgres/postgres/blob/master/src/backend/commands/async.c) | Treat `NOTIFY` as transient wake-up; retain durable alerts and replay them after listener reconnect. |
| [postgis/docker-postgis](https://github.com/postgis/docker-postgis) | Maintained PostgreSQL/PostGIS image tags and PostgreSQL 17/18 compatibility | Use the stable `postgis/postgis:17-3.5` family in the local Compose reference; pin production by immutable digest after review. |
| [vercel/next.js](https://github.com/vercel/next.js) | Current releases and [standalone Docker example](https://github.com/vercel/next.js/tree/canary/examples/with-docker) | Move away from the original Next 14 scaffold to Next 16.4.2, Node 22, lockfile-based install, standalone multi-stage container, and non-root runtime. |
| [tailwindlabs/tailwindcss](https://github.com/tailwindlabs/tailwindcss) | Current Tailwind releases and upgrade notes | Upgrade the inherited Tailwind 3/PostCSS dependency chain to Tailwind 4.3.3 and the official PostCSS plugin after the full dependency audit identified high-severity transitive advisories. |
| [testcontainers/testcontainers-python](https://github.com/testcontainers/testcontainers-python) | Container-backed integration test model | CI uses a real PostGIS service and runs database migration/integration checks rather than relying on mocks for spatial SQL. |
| [OWASP WebSocket Security](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html) | Origin validation, WSS, authentication, connection limits, backpressure, and logging | Add a strict development origin check/cap and document the remaining authentication and deployment controls as required before exposure. |

## Compatibility decision

The original brief called for Next.js 14. The package uses the current stable Next.js release found in the upstream repository review (16.4.2 on 23 October 2026) because a new industry-oriented project should not start on an older major without a specific compatibility need. React and React Leaflet are pinned to releases whose peer requirements match. The lockfile records the exact resolved graph. Versions should be re-reviewed at release time; this report is not a promise that these are the newest versions after that date.

## Limits of this review

The source review does not replace an audit of all transitive dependencies, license review, CVE triage, load testing, or security review. The installed packages are not vendored into the ZIP; the lockfile and `npm ci` make installation deterministic against the registry.
