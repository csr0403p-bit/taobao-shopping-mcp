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

// ── 真实加购（CDP DOM 操作；边界：只点"加入购物车"，永不碰下单/付款）──

const CAPTCHA_RE = /安全验证|拖动滑块|请拖动|CAPTCHA|slide to verify|drag the slider/i;

async function captchaPresent(call) {
  const r = await call('Runtime.evaluate', {
    expression: `!!document.querySelector('[id*=baxia], #nc_1_wrapper, .nc-container, .btn_slide') || CAPTCHA_TEST`,
    // CAPTCHA_TEST 由下方拼接替换（避免正则字面量进模板字符串的转义问题）
  }).catch(() => null);
  return false;
}

// 检测当前页是否为滑块/验证页（中英文都认）
async function isCaptchaPage(call) {
  const r = await call('Runtime.evaluate', {
    expression: `(() => {
      const t = document.body ? document.body.innerText.slice(0, 800) : '';
      const el = !!(document.querySelector('[id*=baxia]') || document.querySelector('.nc-container') || document.querySelector('.btn_slide'));
      const word = /安全验证|拖动滑块|请拖动|CAPTCHA|slide to verify|drag the slider/i.test(t) || /Verification/.test(document.title);
      return el || word;
    })()`,
  }).catch(() => false);
  return !!(r && r.result && r.result.value);
}

// CDP 拟人拖动阿里 nc 滑块：先快后慢 + y 抖动 + 轻微回拉
async function dragCaptcha(call) {
  const info = await call('Runtime.evaluate', {
    expression: `(() => {
      const btn = document.querySelector('[id^=nc_][id$=n1z]') || document.querySelector('.btn_slide');
      if (!btn) return null;
      const track = btn.closest('.nc-lang-cnt') || btn.parentElement.parentElement;
      const b = btn.getBoundingClientRect();
      const t = track ? track.getBoundingClientRect() : b;
      return JSON.stringify({ x: b.x + b.width/2, y: b.y + b.height/2, dx: Math.max(40, t.width - b.width - 6) });
    })()`,
  }).catch(() => null);
  if (!info || !info.result || !info.result.value) return false;
  const { x, y, dx } = JSON.parse(info.result.value);

  const mouse = (type, mx, my) => call('Input.dispatchMouseEvent', {
    type, x: mx, y: my, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
  });

  await mouse('mousePressed', x, y);
  await new Promise(r => setTimeout(r, 120));
  // 轨迹：ease-out 前进 + y 抖动，末尾 3px 回拉
  const steps = 30;
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    const ease = 1 - Math.pow(1 - p, 2.2);           // 先快后慢
    // 关键（人工实测）：该滑块必须拖出轨道最右端才判过——终点 overshoot 22px
    let cx = x + (dx + 22) * ease;
    const cy = y + (Math.sin(i * 1.7) * 1.5);        // y 抖动
    await mouse('mouseMoved', cx, cy);
    await new Promise(r => setTimeout(r, 14 + Math.random() * 22));
  }
  await new Promise(r => setTimeout(r, 150));
  await mouse('mouseReleased', x + dx + 22, y);
  return true;
}

// 新标签 → 首页预热 → 商品页 →（滑块？自动拖，最多2次）→ 选SKU → 点加购 → 检测 → 关标签
// 返回 { ok, message, skuPicked }。滑块拖不过就停手交人工。
export async function addToCartReal(url, skuText) {
  let target;
  try {
    const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new`, { method: 'PUT' });
    target = await r.json();
  } catch { return { ok: false, message: 'CDP 开标签失败（浏览器不可达？）' }; }
  if (!target?.webSocketDebuggerUrl) return { ok: false, message: 'CDP 未返回新标签' };

  const result = await new Promise(resolve => {
    let ws;
    try { ws = new WebSocket(target.webSocketDebuggerUrl); } catch { resolve({ ok: false, message: '连接新标签失败' }); return; }
    const bailout = setTimeout(() => { try { ws.close(); } catch {} resolve({ ok: false, message: '加购流程超时' }); }, 90000);
    ws.addEventListener('open', async () => {
      const call = cdpCall(ws);
      try {
        await call('Page.enable');

        // 1. 站内预热：先开首页再进商品页（降低新标签直连详情页的风控特征）
        await call('Page.navigate', { url: 'https://www.taobao.com' });
        await new Promise(r => setTimeout(r, 2500));

        // 2. 商品页
        await call('Page.navigate', { url });
        await new Promise(r => setTimeout(r, 6000));

        // 3. 滑块（中英文）：自动拟人拖动，最多 2 轮
        for (let round = 0; round < 2; round++) {
          if (!(await isCaptchaPage(call))) break;
          const dragged = await dragCaptcha(call);
          await new Promise(r => setTimeout(r, 3000));
          if (await isCaptchaPage(call)) {
            if (!dragged || round === 1) {
              clearTimeout(bailout); ws.close();
              resolve({ ok: false, message: '滑块验证未通过（自动拖动失败）——需要人工处理：可对该浏览器临时接 VNC/远程桌面过一次验证，或稍后再试' });
              return;
            }
          } else {
            await new Promise(r => setTimeout(r, 3000)); // 验证过后等页面跳转
          }
        }

        // 4. 确认到了商品页
        const onItem = await call('Runtime.evaluate', { expression: '/item\\.htm|detail\\.(tmall|taobao)\\.com/.test(location.href)' });
        if (!onItem?.result?.value) {
          clearTimeout(bailout); ws.close();
          resolve({ ok: false, message: '商品页未正常打开（可能仍被验证拦截或商品下架）' });
          return;
        }

        // 5. 选 SKU（文本精确匹配叶子元素点击）
        let skuPicked = '';
        if (skuText) {
          const pick = await call('Runtime.evaluate', { expression: `(() => {
            const cands = [...document.querySelectorAll('span,div,li')].filter(el => {
              const t = (el.textContent||'').trim();
              return t === ${JSON.stringify(skuText)} && el.children.length === 0 && el.offsetParent !== null;
            });
            if (!cands.length) return '';
            cands[cands.length-1].click();
            return ${JSON.stringify(skuText)};
          })()` });
          skuPicked = pick?.result?.value || '';
          if (!skuPicked) {
            clearTimeout(bailout); ws.close();
            resolve({ ok: false, message: `未在页面上找到规格"${skuText}"——可能文字不完全一致，或先用 shopping_item_detail 看真实 SKU 文案` });
            return;
          }
          await new Promise(r => setTimeout(r, 1800));
        }

        // 6. 点"加入购物车"
        const clicked = await call('Runtime.evaluate', { expression: `(() => {
          const btns = [...document.querySelectorAll('button,div,span,a')].filter(el => {
            const t = (el.textContent||'').trim();
            return t === '加入购物车' && el.offsetParent !== null && el.children.length === 0;
          });
          if (!btns.length) return 0;
          btns[btns.length-1].click();
          return 1;
        })()` });
        if (!clicked?.result?.value) {
          clearTimeout(bailout); ws.close();
          resolve({ ok: false, message: '未找到"加入购物车"按钮（商品可能下架/需选规格/页面结构变化）' });
          return;
        }
        await new Promise(r => setTimeout(r, 3000));

        // 7. 结果检测
        const check = await call('Runtime.evaluate', { expression: `(() => {
          const t = document.body.innerText;
          if (t.includes('成功加入购物车') || t.includes('已加入购物车')) return 'ok';
          if (/安全验证|拖动滑块|CAPTCHA|slide to verify/i.test(t)) return 'captcha';
          if (t.includes('请选择') && (${skuText ? 'false' : 'true'})) return 'need-sku';
          return 'unknown';
        })()` });
        const verdict = check?.result?.value || 'unknown';
        clearTimeout(bailout); ws.close();
        if (verdict === 'ok') resolve({ ok: true, message: '已真实加入淘宝购物车', skuPicked });
        else if (verdict === 'captcha') resolve({ ok: false, message: '加购触发安全验证，已停止——需人工过验证后再试', skuPicked });
        else if (verdict === 'need-sku') resolve({ ok: false, message: '页面要求先选规格——请传 sku 参数（先用 shopping_item_detail 查真实 SKU 文案）' });
        else resolve({ ok: true, message: '已点击加购，未捕获明确成功提示（可用 shopping_check_gifts 核对购物车）', skuPicked });
      } catch (e) {
        clearTimeout(bailout);
        try { ws.close(); } catch {}
        resolve({ ok: false, message: `加购流程异常: ${e.message}` });
      }
    });
    ws.addEventListener('error', () => { clearTimeout(bailout); resolve({ ok: false, message: 'CDP 连接错误' }); });
  });

  try { await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${target.id}`); } catch {}
  return result;
}
