// B 路径后端：转发到本机 taobao-mcp-bridge relay（OpenCLI → 浏览器扩展 → 已登录网页）
// relay: http://127.0.0.1:18126/mcp （Bearer token 见 %LOCALAPPDATA%\TaobaoMCPBridge\access.token）
// B 只能浏览：search / detail / images / favorites / cart 只读。无加购。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const RELAY_URL = process.env.TAOBAO_RELAY_URL || 'http://127.0.0.1:18126/mcp';

function readToken() {
  if (process.env.TAOBAO_RELAY_TOKEN) return process.env.TAOBAO_RELAY_TOKEN;
  const candidates = [
    process.env.TAOBAO_RELAY_TOKEN_FILE,                          // 显式指定（推荐）
    'taobao-relay.token',                                           // 工作目录
    path.join(os.homedir(), '.taobao-shopping', 'relay.token'),      // 用户目录约定
  ];
  for (const c of candidates) {
    try { return fs.readFileSync(c, 'utf8').trim() || null; } catch { /* next */ }
  }
  return null;
}

let jobId = 0;

async function rpc(method, params) {
  const token = readToken();
  if (!token) throw new Error('B 路径 token 不存在（%LOCALAPPDATA%\\TaobaoMCPBridge\\access.token）');
  const res = await fetch(RELAY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++jobId, method, params }),
  });
  if (!res.ok) throw new Error(`relay HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`relay: ${j.error.message}`);
  return j.result;
}

async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r?.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// B 的 job 模型：先提交拿 job_id，再轮询到 completed
async function runJob(args, { maxWaitMs = 90000, stepMs = 5000 } = {}) {
  const submit = await callTool('taobao_web', args);
  if (submit.state !== 'accepted' || !submit.job_id) return submit;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, stepMs));
    const d = await callTool('taobao_job', { job_id: submit.job_id });
    if (d.state === 'completed') return d.result ?? d;
  }
  throw new Error('B 路径任务超时');
}

export async function bSearch(keyword) {
  const r = await runJob({ action: 'search', keyword });
  if (r.ok === false) throw new Error(`B搜索失败: ${JSON.stringify(r.error)}`);
  return (r.items || []).map(it => ({
    itemId: it.product_id,
    title: it.title,
    url: it.url,
  }));
}

export async function bDetail(url) {
  const r = await runJob({ action: 'detail', url });
  if (r.ok === false) throw new Error(`B详情失败: ${JSON.stringify(r.error)}`);
  return r;
}

export async function bCart(keyword) {
  const r = await runJob({ action: 'cart', keyword: keyword || '' });
  if (r.ok === false) throw new Error(`B购物车读取失败: ${JSON.stringify(r.error)}`);
  return r;
}

export async function bPing() {
  try {
    const r = await rpc('tools/list', {});
    return (r?.tools || []).length > 0;
  } catch {
    return false;
  }
}
