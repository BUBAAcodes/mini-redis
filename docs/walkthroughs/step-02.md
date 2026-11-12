# Step 02: Docker and CI skeleton

## What this step built

A two-stage Dockerfile that compiles TypeScript in a build stage and ships only `dist/` (no `node_modules`, because there are no runtime dependencies). A Compose file that runs MiniRedis, the Redis 7.4 reference server and, under the `replication` profile, two MiniRedis replicas. A GitHub Actions workflow that installs, lints, typechecks, builds and runs `npm test` with coverage on every push and pull request.

## One real request's path: the container healthcheck

There is no MiniRedis server yet (step 5), so this follows the healthcheck, the first thing that will ever talk to it.

1. `Dockerfile:19`: Docker runs `node healthcheck.js` every 5 s.
2. `docker/healthcheck.js:2`: it opens a TCP connection to `127.0.0.1:6380` inside the container.
3. `docker/healthcheck.js:5`: on connect it writes the **inline** command `PING\r\n` (not RESP), which exercises the inline parser built in step 3.
4. `docker/healthcheck.js:6`: `+PONG` or `-NOAUTH` (a password is set but the server is alive) exits 0, so the container is healthy. Anything else exits 1.
5. `docker-compose.yml:20`: `replica1` and `replica2` use `condition: service_healthy`, so they only start once the primary passes step 4.

The CI path: `.github/workflows/ci.yml` runs checkout → setup-node 26 with the npm cache → `npm ci` → `npm run lint` → `npm run typecheck` → `npm run build` → `npm test -- --coverage` → upload `coverage/`.

## Key pieces and why each exists

- **Build stage / runtime stage split**: dev tools (tsc, vitest, eslint) never reach the final image, which keeps it small and gives it no attack surface from npm packages.
- **`ENTRYPOINT … --bind 0.0.0.0 --dir /data`**: the default `bind` is `127.0.0.1` (safe on a laptop), but inside a container the port mapping needs the server to listen on all interfaces. Compose then publishes it only on host `127.0.0.1`.
- **`USER node` and `VOLUME /data`**: the server never runs as root, and data outlives the container.
- **`redis` service**: the referee. Differential tests (step 8) and benchmarks (step 24) compare against it, and `docker compose exec redis redis-cli …` answers "what does Redis do here?".
- **`.prettierignore` gets `docker-compose.yml`**: the spec's file is hand-wrapped, and `prettier --check .` would otherwise fail on it.
- **ESLint `process` global for `docker/**/*.js`**: `no-undef` is on for JS files, and typescript-eslint only turns it off for `.ts`.
- **`dependabot.yml`**: weekly update PRs for dev dependencies and Actions versions (§17 "Also").

## Trade-offs, and what Redis does differently

- The official Redis image (`docker-library/redis`, its `docker-entrypoint.sh`) starts as root and drops privileges with `gosu`. We start as `node` directly, because we never need to fix volume ownership at runtime: the image pre-creates `/data`.
- Redis's healthchecks are usually `redis-cli ping`. We can't count on `redis-cli` being in our image, so a 6-line Node script does the same job.
- CI is a skeleton for now: differential, crash, fuzz and replication suites, `docker build` and the GHCR push join as their steps arrive (§17).

## The single most important line

`ENTRYPOINT ["node", "dist/index.js", "--bind", "0.0.0.0", "--dir", "/data"]`. Without `--bind 0.0.0.0`, the server listens only on the container's own loopback, the published port goes nowhere, and every client outside the container fails. No unit test catches this yet. The Compose `replication` profile in step 21 will: the replicas can never reach `miniredis:6380`.

## Quiz

1. Why does the final image contain no `node_modules`?
2. Why does the healthcheck accept `-NOAUTH` as healthy?
3. Why is the host port mapping `127.0.0.1:6380:6380` and not just `6380:6380`?

<details>
<summary>Answers</summary>

1. MiniRedis has zero runtime dependencies. `dist/` is plain JS using only Node built-ins, so `npm ci` is needed only in the build stage, for `tsc`.
2. With `requirepass` set, an unauthenticated PING gets `-NOAUTH Authentication required.`. That reply still proves the server accepted a connection and parsed a command, which is all "healthy" means.
3. `6380:6380` publishes on every host interface, so a passwordless database would be reachable from the network. Binding the host side to loopback keeps it local.

</details>
