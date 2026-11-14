import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { exec, spawn } from 'node:child_process';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';
const TTYD_PORT = parseInt(process.env.TTYD_INTERNAL_PORT || '7681', 10);

function cleanEnvValue(val) {
  const s = String(val || '').trim();
  return !s || s.startsWith('${') ? '' : s;
}

const TTYD_USER = cleanEnvValue(process.env.TTYD_USER);
const TTYD_PASSWORD = cleanEnvValue(process.env.TTYD_PASSWORD);
let ttydProc = null;

function startTtydSupervisor() {
  if (!TTYD_USER || !TTYD_PASSWORD) {
    console.log('[pidev] TTYD_USER/TTYD_PASSWORD not set; /terminal web shell disabled for security.');
    return;
  }
  const cwd = fs.existsSync('/var/www/webdev') ? '/var/www/webdev' : '/var/www';
  const launch = () => {
    const bin = fs.existsSync('/usr/local/bin/ttyd') ? '/usr/local/bin/ttyd' : '/var/www/bin/ttyd';
    if (!fs.existsSync(bin)) {
      console.warn(`[pidev] ttyd binary not found at ${bin}; /terminal unavailable.`);
      return;
    }
    ttydProc = spawn(
      bin,
      ['-i', '127.0.0.1', '-p', String(TTYD_PORT), '-W', '-b', '/terminal', '-c', `${TTYD_USER}:${TTYD_PASSWORD}`, 'bash', '-l'],
      { cwd, env: { ...process.env, TERM: 'xterm-256color' }, stdio: 'ignore' }
    );
    ttydProc.on('exit', (code) => {
      ttydProc = null;
      console.warn(`[pidev] ttyd exited (${code}); restarting in 2s...`);
      setTimeout(launch, 2000).unref();
    });
  };
  launch();
}

function isTerminalPath(pathname) {
  return pathname === '/terminal' || pathname.startsWith('/terminal/');
}

function proxyTerminalHttp(req, res) {
  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: TTYD_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${TTYD_PORT}` },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: `Terminal upstream unavailable: ${err.message}` }));
    } else {
      res.destroy();
    }
  });
  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (isTerminalPath(url.pathname)) {
    proxyTerminalHttp(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/' && String(req.headers.accept || '').includes('text/html') && TTYD_USER && TTYD_PASSWORD) {
    res.writeHead(302, { Location: '/terminal/' });
    res.end();
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'HEAD' && (url.pathname === '/execute' || url.pathname === '/health' || url.pathname === '/healthz' || url.pathname === '/')) {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz' || url.pathname === '/')) {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      service: 'pidev',
      node_version: process.version,
      agent: 'gentle-pi',
      terminal_enabled: Boolean(TTYD_USER && TTYD_PASSWORD),
      terminal_path: '/terminal/',
      cwd: process.cwd()
    }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    exec('gentle-shell --version', (err, stdout) => {
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'ok',
        service: 'pidev',
        version: (stdout || '').trim(),
        uptime: process.uptime(),
        memory: process.memoryUsage()
      }));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/execute') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const ctx = payload.context && typeof payload.context === 'object' ? payload.context : {};
        const rawCommand = payload.command;
        const prompt = payload.prompt || ctx.prompt || ctx.task || ctx.issueTitle || ctx.wakeReason || '';
        const cwd = payload.cwd || process.cwd();

        if (!rawCommand && !prompt) {
          res.writeHead(400);
          res.end(JSON.stringify({ status: 'error', message: 'Missing "command" or "prompt" parameter' }));
          return;
        }

        const env = {
          ...process.env,
          CI: 'true',
          NON_INTERACTIVE: 'true',
          GENTLE_SHELL_NO_AUTO_SETUP: '1',
          PATH: `/mnt/localstorage/bin:/home/zerops/.local/bin:/usr/local/bin:${process.env.PATH || ''}`
        };
        if (!env.OPENAI_BASE_URL) env.OPENAI_BASE_URL = 'http://bifrost:8080/v1';
        if (!env.OPENAI_API_KEY) env.OPENAI_API_KEY = 'vk-pidev';

        const model = String(payload.model || 'auto').replace(/[^a-zA-Z0-9_./:-]/g, '') || 'auto';
        const command = rawCommand || (prompt ? (prompt.startsWith('pi ') || prompt.startsWith('gentle-shell ') ? prompt : `pi --no-session --provider bifrost --model ${model} -p '${String(prompt).replace(/'/g, "'\\''")}' < /dev/null`) : '');

        exec(command, { cwd, env, timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err && !stdout) {
            res.writeHead(500);
            res.end(JSON.stringify({
              status: 'error',
              message: err.message,
              stdout: (stdout || '').trim(),
              stderr: (stderr || '').trim()
            }));
            return;
          }
          res.writeHead(200);
          res.end(JSON.stringify({
            status: 'ok',
            output: (stdout || '').trim(),
            stderr: (stderr || '').trim(),
            exitCode: err ? err.code : 0
          }));
        });
      } catch (parseErr) {
        res.writeHead(400);
        res.end(JSON.stringify({ status: 'error', message: 'Invalid JSON payload' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ status: 'error', message: 'Not found' }));
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (!isTerminalPath(url.pathname)) {
    socket.destroy();
    return;
  }
  const upstream = net.connect(TTYD_PORT, '127.0.0.1', () => {
    socket.setTimeout(0);
    upstream.setTimeout(0);
    const headerLines = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      const v = req.rawHeaders[i + 1];
      if (k.toLowerCase() === 'host') {
        headerLines.push(`Host: 127.0.0.1:${TTYD_PORT}`);
      } else {
        headerLines.push(`${k}: ${v}`);
      }
    }
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headerLines.join('\r\n')}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

startTtydSupervisor();

server.listen(PORT, HOST, () => {
  console.log(`[pidev] Gentle-Pi HTTP Runner listening on ${HOST}:${PORT} (terminal=${Boolean(TTYD_USER && TTYD_PASSWORD)})`);
});
