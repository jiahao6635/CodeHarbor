# CodeGraph read-only runtime

This image compiles upstream CodeGraph 1.6.2 from the pinned source archive. The
archive SHA-256 is checked before extraction, `readonly-mcp.patch` selects the
upstream read-only MCP engine and prevents the direct-mode writer lock when
`CODEGRAPH_MCP_READ_ONLY=1`, and upstream's MIT license is retained in `LICENSE`.
The runtime explicitly enables search, callers, callees, impact, node, explore
and files. The patch preserves that explicit allowlist for small repositories;
upstream otherwise hides some tools below 500 files. Both node modes operate on
the published repository snapshot, never the client's local working copy.
The final image uses a separate locked set of runtime dependencies and omits the
upstream UI workspace; it does not contain the build-stage dev dependencies.

```sh
docker build -f codegraph-readonly/Dockerfile \
  -t codeharbor-codegraph-readonly:1.6.2 codegraph-readonly
CODEHARBOR_READONLY_TEST_IMAGE=codeharbor-codegraph-readonly:1.6.2 \
  node --test tests/codegraph-readonly.test.mjs
```

The base image does not include a repository. The controlled image builder must
copy a single repository and its complete index to `/workspace/repo`, seal the
index as a standalone SQLite database, and retain readable ownership for UID
1000. `seal-index.cjs` is provided for the separate build-time path where the
index was generated in the image. It must only run after all index writers have
exited; it checkpoints WAL, switches to DELETE journal mode, and checks index
integrity. The alternative backup-based builder must preserve the same property.

Run the resulting repository image with a read-only root filesystem, no repository
mount, no outbound network, UID/GID 1000, and the built-in read-only environment.
Only the fixed MCP entrypoint should be invoked by the gateway. The flags alone
are not a sandbox: container isolation, image provenance, and restricted access
to the container runtime are also required.
