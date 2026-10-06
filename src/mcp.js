// MCP JSON-RPC 2.0 处理（Streamable HTTP，单 POST JSON 模式，兼容 our-claude mcp-client.ts）
// 无状态实现：不强制 session，Mcp-Session-Id 头原样回显

import { TOOL_DEFS, dispatch, setPolicy } from './tools.js';

const SERVER_INFO = { name: 'shopping-mcp', version: '0.1.0' };
const PROTOCOL = '2024-11-05';

export async function handleRpc(body, config) {
  const { id, method, params } = body;
  setPolicy(config.policy);

  const reply = (result) => ({ jsonrpc: '2.0', id, result });

  try {
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });

      case 'notifications/initialized':
      case 'initialized':
        return null; // 通知无响应

      case 'ping':
        return reply({});

      case 'tools/list':
        return reply({ tools: TOOL_DEFS });

      case 'tools/call': {
        const result = await dispatch(params?.name, params?.arguments || {});
        return reply(result);
      }

      case 'resources/list':
        return reply({ resources: [] });

      case 'prompts/list':
        return reply({ prompts: [] });

      default:
        if (id !== undefined && id !== null) {
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
        }
        return null;
    }
  } catch (err) {
    if (id !== undefined && id !== null) {
      return { jsonrpc: '2.0', id, error: { code: -32000, message: err.message } };
    }
    console.error('[mcp] unhandled notification error:', err.message);
    return null;
  }
}
