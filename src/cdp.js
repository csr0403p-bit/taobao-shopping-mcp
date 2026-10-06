// CDP 登录截图：浏览器留着 --remote-debugging-port=9223，
// 登录态过期时导航到淘宝登录页并截取二维码视图 → base64 PNG

const DEBUG_PORT = Number(process.env.TAOBAO_CDP_PORT || 9223);
const LOGIN_URL = 'https://login.taobao.com/member/login.jhtml';
const QR_WAIT_MS = 6000;      // 二维码渲染等待
const THROTTLE_MS = 30000;    // 节流：连续触发时不反复导航截图

let lastShot = { at: 0, data: null };

function getJson(path) {
  return fetch(`http://127.0.0.1:${DEBUG_PORT}${path}`).then(r => r.json());
}

async function pickPage() {
  const targets = await getJson('/json/list');
  return (
    targets.find(t => t.type === 'page' && /taobao|tmall/.test(t.url)) ||
    targets.find(t => t.type === 'page') ||
    null
  );
}

function cdpCall(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
    }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    const timer = setTimeout(() => { pending.delete(i); reject(new Error(`CDP 超时: ${method}`)); }, 20000);
    pending.set(i, r => { clearTimeout(timer); resolve(r); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

// 返回 base64 PNG（无 data: 前缀）。CDP 不可达返回 null。
export async function loginQRBase64() {
  if (Date.now() - lastShot.at < THROTTLE_MS && lastShot.data) return lastShot.data;

  let page;
  try { page = await pickPage(); } catch { return null; }
  if (!page) return null;

  return await new Promise(resolve => {
    let ws;
    try { ws = new WebSocket(page.webSocketDebuggerUrl); } catch { resolve(null); return; }
    const bailout = setTimeout(() => { try { ws.close(); } catch {} resolve(null); }, QR_WAIT_MS + 25000);
    ws.addEventListener('open', async () => {
      try {
        const call = cdpCall(ws);
        await call('Page.enable');
        await call('Page.navigate', { url: LOGIN_URL });
        await new Promise(r => setTimeout(r, QR_WAIT_MS));
        const shot = await call('Page.captureScreenshot', { format: 'png' });
        clearTimeout(bailout);
        ws.close();
        lastShot = { at: Date.now(), data: shot.data };
        resolve(shot.data);
      } catch {
        clearTimeout(bailout);
        try { ws.close(); } catch {}
        resolve(null);
      }
    });
    ws.addEventListener('error', () => { clearTimeout(bailout); resolve(null); });
  });
}
