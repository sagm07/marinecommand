# Security and deployment boundary

This repository is for local development and controlled demonstrations. It does not implement an identity provider or per-vessel/role authorization. In production mode, the API requires `AUTH_MODE=trusted_proxy` and checks that an identity-aware reverse proxy supplies `X-Authenticated-User`; the proxy must perform the actual login and authorization, strip any client-supplied identity headers, and be the only network path to the API. The loopback-only ports in Compose reduce accidental exposure on a developer workstation; they are not an access-control boundary on a shared host.

## Before exposing it outside localhost

1. Put the service behind an OIDC-capable identity-aware proxy or implement OIDC in the application. Configure `APP_ENV=production`, `AUTH_MODE=trusted_proxy`, and exact HTTPS origins. Require authentication for all API routes and the WebSocket handshake, and authorize vessels, zones, and alert visibility by role/tenant at the proxy or application.
2. Restrict WebSocket `Origin` to a strict allowlist, require WSS, rotate/expire credentials, cap connections and message sizes, and log connect/disconnect/auth/rate-limit events without logging tokens or full sensitive payloads.
3. Use a reverse proxy with TLS and WebSocket upgrade support. Set idle/read timeouts for long-lived connections. Keep the API, database, and administration interfaces on private networks.
4. Use a separate non-superuser runtime role and a separate migration owner. Store secrets in a managed secret store; do not use `.env` for production credentials. Apply least privilege and rotate credentials.
5. Validate every telemetry field, reject invalid coordinates/units, rate-limit device ingest, and authenticate devices. This sample simulator is trusted local code and is not a secure ingest protocol.
6. Set strict CORS and WebSocket origin allowlists; do not use wildcard origins with credentials. Add CSRF/session protections if browser cookies are used.
7. Run dependency and container scanning, pin deploy images by digest, use signed build artifacts, keep an SBOM, and have a patch/rollback process.

The WebSocket origin check in the sample protects against accidental cross-origin browser connections. Origin checking alone is not authentication: non-browser clients can forge the header.

## Data handling

GPS tracks may reveal sensitive operational patterns. Decide data ownership and retention, encrypt disks and backups, restrict database logs, and audit access. Set a retention policy for telemetry and alerts. The demo has no automated purging or privacy controls.

## Threats to test

- Unauthorized and cross-tenant API/WebSocket access.
- Cross-Site WebSocket Hijacking and hostile/missing Origin headers.
- Credential leakage from URLs, browser storage, container logs, source maps, and build arguments.
- Oversized payloads, connection exhaustion, slow WebSocket readers, malformed JSON, and reconnect storms.
- SQL injection through device inputs (all sample SQL parameters are bound, but new routes must preserve this).
- Database privilege escalation, role compromise, restore from untrusted backup, and exposed PostgreSQL ports.

## Safety boundary

This software emits operator alerts. It is not certified, safety-rated, fail-operational, or validated for autonomous vessel control. Do not couple the demo alert output directly to steering or propulsion decisions. A qualified maritime/safety engineering review, hazard analysis, and system-specific verification are required before any operational reliance.
