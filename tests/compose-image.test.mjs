import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const available = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  YUNXIAO_ENDPOINT: 'https://example.invalid', CODEHARBOR_GIT_HOSTS: 'example.invalid',
  CODEHARBOR_ALLOWED_HOSTS: 'example.invalid', CODEHARBOR_VAULT_ADDR: 'https://vault.invalid',
  CODEHARBOR_VAULT_TRANSIT_KEY: 'test', CODEHARBOR_NGINX_IMAGE: 'nginx:alpine',
  CODEHARBOR_TLS_CERT: '/tmp/cert', CODEHARBOR_TLS_KEY: '/tmp/key', CODEHARBOR_DATABASE_URL_FILE: '/tmp/db',
  CODEHARBOR_VAULT_TOKEN_FILE: '/tmp/vault', CODEHARBOR_VAULT_WRAPPED_KEY_FILE: '/tmp/wrapped',
  CODEHARBOR_METRICS_TOKEN_FILE: '/tmp/metrics', CODEHARBOR_POSTGRES_PASSWORD_FILE: '/tmp/postgres',
  CODEHARBOR_POSTGRES_ADMIN_PASSWORD_FILE: '/tmp/admin', CODEHARBOR_POSTGRES_TLS_CERT: '/tmp/pgcert',
  CODEHARBOR_POSTGRES_TLS_KEY: '/tmp/pgkey', CODEHARBOR_POSTGRES_CA_CERT: '/tmp/pgca',
  CODEHARBOR_REPOSITORY_RUNTIME_IMAGE: `sha256:${'a'.repeat(64)}`, CODEHARBOR_IMAGE_CONTROLLER_ID: 'test',
  CODEHARBOR_IMAGE_CONTROLLER_SOCKET_DIR: '/tmp/controller', CODEHARBOR_IMAGE_AUTHORIZER_SOCKET_DIR: '/tmp/authorizer',
  CODEHARBOR_IMAGE_STATE_DIR: '/tmp/image-state', CODEHARBOR_IMAGE_QUERY_TOKEN_HOST_FILE: '/tmp/query',
  CODEHARBOR_IMAGE_BUILD_TOKEN_HOST_FILE: '/tmp/build', CODEHARBOR_IMAGE_AUTH_TOKEN_HOST_FILE: '/tmp/auth',
};

for (const localPostgres of [false, true]) {
  test(`image Compose confines Docker socket and Git storage${localPostgres ? ' with local PostgreSQL' : ''}`, { skip: !available }, () => {
    const files = ['-f', 'deploy/compose.yaml', ...(localPostgres ? ['-f', 'deploy/compose.postgres.yaml'] : []), '-f', 'deploy/compose.image.yaml'];
    const raw = execFileSync('docker', ['compose', '--env-file', '/dev/null', ...files, 'config', '--format', 'json'], { cwd: resolve('.'), env, encoding: 'utf8' });
    const config = JSON.parse(raw); const app = config.services.codeharbor; const controller = config.services['image-controller'];
    assert.equal(app.environment.CODEHARBOR_INDEX_BACKEND, 'image');
    assert.equal(app.environment.TMPDIR, '/data');
    assert.equal(app.volumes.some((volume) => ['/data', '/var/run/docker.sock'].includes(volume.target)), false);
    assert.ok(app.tmpfs.some((item) => item.startsWith('/data:')));
    assert.equal(controller.volumes.filter((volume) => volume.target === '/var/run/docker.sock').length, 1);
    assert.ok(controller.volumes.some((volume) => volume.target === '/var/lib/codeharbor-image-controller'));
    assert.equal(controller.network_mode, 'none'); assert.equal(controller.read_only, true);
    assert.deepEqual(controller.cap_drop, ['ALL']); assert.ok(!controller.cap_add?.length);
    for (const name of ['image_query_token', 'image_build_token', 'image_auth_token', 'database_url', 'vault_token']) assert.ok(app.secrets.some((item) => item.source === name));
    if (localPostgres) {
      assert.ok(config.services.postgres); assert.ok(app.depends_on.postgres);
      assert.ok(app.secrets.some((item) => item.source === 'postgres_ca'));
      for (const name of ['postgres_password', 'postgres_admin_password', 'postgres_tls_cert', 'postgres_tls_key']) assert.ok(config.services.postgres.secrets.some((item) => item.source === name));
    }
  });
}
