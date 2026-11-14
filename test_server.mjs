import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  buildTerminalSpawnArgs,
  createPidevServer,
  resolveAllowedOrigin,
} from './server.mjs';

function request(server, method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('POST /execute fails closed with 403 when PIDEV_EXECUTE_TOKEN is not configured', async () => {
  const server = createPidevServer({});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await request(server, 'POST', '/execute', { 'Content-Type': 'application/json' }, '{"command":"echo hi"}');
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('POST /execute returns 401 without valid token and 200 with valid Bearer token', async () => {
  const server = createPidevServer({ PIDEV_EXECUTE_TOKEN: 'secret-token-123' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const noAuth = await request(server, 'POST', '/execute', { 'Content-Type': 'application/json' }, '{"command":"echo hi"}');
    assert.equal(noAuth.status, 401);

    const badAuth = await request(
      server,
      'POST',
      '/execute',
      { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      '{"command":"echo hi"}'
    );
    assert.equal(badAuth.status, 401);

    const okAuth = await request(
      server,
      'POST',
      '/execute',
      { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token-123' },
      '{"command":"echo ok"}'
    );
    assert.equal(okAuth.status, 200);
    assert.equal(JSON.parse(okAuth.body).output, 'ok');
  } finally {
    server.close();
  }
});

test('CORS blocks arbitrary origins and allows localhost or configured origins', () => {
  assert.equal(resolveAllowedOrigin('https://evil.example.com', {}), '');
  assert.equal(resolveAllowedOrigin('http://localhost:4321', {}), 'http://localhost:4321');
  assert.equal(
    resolveAllowedOrigin('https://paperclip.example.com', { PIDEV_ALLOWED_ORIGINS: 'https://paperclip.example.com' }),
    'https://paperclip.example.com'
  );
});

test('buildTerminalSpawnArgs uses tmux + pi TUI instead of bash -l', () => {
  const args = buildTerminalSpawnArgs(7681, 'zerops', 'pass', true);
  assert.ok(args.includes('tmux'));
  assert.ok(args.includes('pi --provider bifrost --model auto'));
  assert.ok(!args.includes('bash'));
});
