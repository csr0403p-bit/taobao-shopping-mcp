// shopping-mcp 入口 —— 本地 Windows Node 服务
// Bearer token 鉴权 + POST /mcp（Streamable HTTP JSON）+ GET /health
// 部署形态：本地/服务器常驻，经隧道或直连暴露给云端 LLM 客户端

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRpc } from './mcp.js';
import { bPing } from './backend-b.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = process.env.SHOPPING_CONFIG || path.join(ROOT, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`[shopping-mcp] 缺少配置文件 ${CONFIG_PATH}，请复制 config.example.json 为 config.json 并填写`);
    process.exit(1);
  }
}

const config = loadConfig();
const PORT = config.port || 3980;
const TOKEN = config.token;

function auth(req) {
  if (!TOKEN) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${TOKEN}` || h === `Bearer ${TOKEN}`.toLowerCase() && h.startsWith('Bearer ');
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    const up = await bPing().catch(() => false);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'shopping-mcp', browseBackend: up ? 'up' : 'down' }));
    return;
  }

  if (url.pathname === '/mcp') {
    if (!auth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req) || '{}');
        const response = await handleRpc(body, config);
        if (response === null) { res.writeHead(202); res.end(); return; }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': req.headers['mcp-session-id'] || 'shopping',
        });
        res.end(JSON.stringify(response));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: err.message } }));
      }
      return;
    }
    // GET/DELETE /mcp：无状态服务，直接 405（Streamable HTTP 允许）
    res.writeHead(405, { Allow: 'POST' });
    res.end();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[shopping-mcp] listening on http://127.0.0.1:${PORT}/mcp (bearer token ${TOKEN ? 'on' : 'OFF — 危险'})`);
});
