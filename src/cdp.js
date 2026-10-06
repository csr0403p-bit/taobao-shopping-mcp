// CDP 登录截图：浏览器留着 --remote-debugging-port=9223，
// 登录态过期/首次部署时导航到登录页并截取二维码视图 → base64 PNG

const DEBUG_PORT = Number(process.env.TAOBAO_CDP_PORT || 9223);
const QR_WAIT_MS = 6000;      // 二维码渲染等待
const THROTTLE_MS = 30000;    // 节流：连续触发时不反复导航截图

// 支持的登录站点（默认淘宝；toggle=true 的需要先点"二维码登录"切换钮）
const LOGIN_SITES = {
  taobao: { login: 'https://login.taobao.com/member/login.jhtml', match: /taobao|tmall/, toggle: null },
  douban: {
    login: 'https://accounts.douban.com/passport/login', match: /douban/, toggle:
      "() => { const t = document.querySelector('.qrcode-login, .qr-login, [class*=qrcode]'); if (t) { t.click(); return 1; } const links = document.querySelectorAll('a'); if (links.length > 3) { links[3].click(); return 1; } return 0; }",
  },
  xhs:    { login: 'https://www.xiaohongshu.com/login', match: /xiaohongshu/, toggle: null },
};

const lastShot = new Map();  // site -> { at, data }

function getJson(path) {
  return fetch(`http://127.0.0.1:${DEBUG_PORT}${path}`).then(r => r.json());
}

async function pickPage(match) {
  const targets = await getJson('/json/list');
  return (
    targets.find(t => t.type === 'page' && match.test(t.url)) ||
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

// 返回 base64 PNG（无 data: 前缀）。CDP 不可达返回 null。site: 'taobao'|'douban'|'xhs'
export async function loginQRBase64(siteName = 'taobao') {
  const site = LOGIN_SITES[siteName] || LOGIN_SITES.taobao;
  const cached = lastShot.get(siteName);
  if (Date.now() - cached?.at < THROTTLE_MS && cached?.data) return cached.data;

  let page;
  try { page = await pickPage(site.match); } catch { return null; }
  if (!page) return null;

  return await new Promise(resolve => {
    let ws;
    try { ws = new WebSocket(page.webSocketDebuggerUrl); } catch { resolve(null); return; }
    const bailout = setTimeout(() => { try { ws.close(); } catch {} resolve(null); }, QR_WAIT_MS + 25000);
    ws.addEventListener('open', async () => {
      try {
        const call = cdpCall(ws);
        await call('Page.enable');
        await call('Page.navigate', { url: site.login });
        await new Promise(r => setTimeout(r, QR_WAIT_MS));
        if (site.toggle) {
          // 该站默认不是二维码面板：注入点击切换
          await call('Runtime.evaluate', { expression: `(${site.toggle})()` }).catch(() => {});
          await new Promise(r => setTimeout(r, 2500));
        }
        const shot = await call('Page.captureScreenshot', { format: 'png' });
        clearTimeout(bailout);
        ws.close();
        lastShot.set(siteName, { at: Date.now(), data: shot.data });
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
