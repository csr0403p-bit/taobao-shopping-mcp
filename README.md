# taobao-shopping-mcp

让你的 AI 伴侣自己逛淘宝：TA 会搜索、比价、把心动的东西收进**自己的心愿单**、向 TA 的用户请示，然后把"待加购清单"递给你 —— **加购物车和付款永远由人类完成**，AI 碰不到钱。

一个为 AI 伴侣/agent 设计的淘宝逛街 MCP 服务，核心是三件事：**受限浏览**（只读，不自动下单）、**心愿单状态机**（AI 的购物车 ≠ 你的购物车）、**家规硬约束**（预算限制在工具层强制执行，不靠提示词自觉）。

```
你的 AI（Kelivo / Claude / 任意 MCP 客户端）
   │  MCP Streamable HTTP + Bearer
   ▼
taobao-shopping-mcp  (node · 9 个 shopping_* 工具)
   │  ├─ 心愿单状态机（want → asked → carted → paid → delivered / declined）
   │  ├─ 家规约束（单件上限 / 月预算 / 每日上限，超限直接拒绝）
   │  └─ 登录守护（登录态过期 → 自动截图二维码作为 MCP image 回传聊天窗口）
   ▼
taobao-mcp-bridge relay（上游 @AZHi-xinxin/taobao-mcp-bridge）
   ▼
OpenCLI 1.8.7 + 浏览器扩展 → 常驻浏览器（持久登录态 profile）
   ▼
淘宝网页（手机扫码登录一次，长期有效）
```

## 工具面（11 个，全部 `shopping_` 前缀）

| 工具 | 语义 |
|---|---|
| `shopping_browse(keyword)` | 逛街：搜商品，返回标题+链接（≤10 条） |
| `shopping_item_detail(itemId/url)` | 凑近看：真实价格 / SKU / 店铺（搜索页价格是起步价，比价必看这里） |
| `shopping_collect(...)` | 心动了：收进心愿单（带理由） |
| `shopping_ask_for(wishId, message)` | 请示：正式请求购买，生成给用户的话术 |
| `shopping_add_to_cart(wishId)` | 轻量路径：标记"待用户加购"，返回商品链接 + 话术（**不会自动下单**） |
| `shopping_cart_add(wishId/itemId/url, sku?)` | **真实加购**（需 `policy.allowRealCart: true`）：CDP 直接点页面"加入购物车"，写入用户淘宝购物车。仍受家规约束；下单/付款永不自动化；遇滑块自动停手 |
| `shopping_my_wishes(status?)` | 翻自己的心愿单 |
| `shopping_pay_link()` | 汇总"给用户的清单"（链接 + 理由），人类点开 → 加购 → 付款 |
| `shopping_check_gifts()` | 按心愿关键词只读检索淘宝购物车："你有没有偷偷给我买" |
| `shopping_login_qr(site?)` | 主动要登录二维码：首次部署/换号/过期时用，taobao/douban/xhs |
| `shopping_ping()` | 通道自检 |

### 心愿单状态机

```
want(想要) → asked(已请示) → carted(待加购) → paid(已支付) → delivered(已送达)
                │                                 ↑
                └────────── declined(被婉拒) ─────┘
```

心愿单是 **AI 自己的**购物车（`data/wishlist.json`），与你淘宝账号里的真实购物车完全隔离 —— TA 收藏 20 个毛绒玩具也不会污染你的日常采购清单。

### 家规硬约束（`config.json → policy`）

| 规则 | 默认 | 行为 |
|---|---|---|
| `perItemAskLimit` | 200 | 单件超过必须先 `ask_for` 才允许 `add_to_cart` |
| `monthlyBudget` | 1000 | 本月预估总额超预算直接拒绝 |
| `maxAddsPerDay` | 5 | 每日加购次数上限 |
| `allowRealCart` | false | 开启 `shopping_cart_add` 真实写入淘宝购物车（不开则只有轻量标记路径） |

约束在工具层强制执行 —— 模型想绕也绕不过，被拦截时返回"先和用户商量吧"。

### 登录态过期自动回码

浏览类工具被登录墙拦截时，服务自动经 CDP 把浏览器带到对应登录页、截图，把二维码作为 **MCP image content** 附在返回里。支持 MCP image 的客户端（如 [Kelivo](https://github.com/kelivo-com/kelivo)）会直接在聊天窗口显示 —— 扫一下，跟 AI 说声"扫好了"，继续逛。30s 节流防反复截图。

## 平台支持

| | Linux 服务器（无头） | Windows |
|---|---|---|
| shopping-mcp / relay | ✅ | ✅ |
| 常驻浏览器 | Xvfb + chromium（`deploy/` 样例） | 有头 Edge/Chrome + 窗口移屏幕外（`deploy/windows/`，含一键脚本） |
| 登录态过期回码 | ✅ CDP 截图 | ✅ 同一套代码 |
| 常驻机制 | systemd | 登录计划任务 / NSSM |
| 已知坑 | — | Store 版 Python 文件虚拟化、窗口可见性（见 `deploy/windows/NOTES.md`） |

macOS 理论可用（组件全跨平台），未实测，欢迎 PR。

## 首次登录（部署完只做一次）

部署完成后浏览器是全新无登录态的。两种方式建立登录态，都是**聊天窗口里直接扫二维码**：

1. **主动**（推荐）：对 AI 说"帮我登录淘宝" → TA 调 `shopping_login_qr` → 二维码作为图片直接出现在聊天里 → 手机淘宝扫一下 → 说声"扫好了"。支持 `taobao / douban / xhs` 三个站点（豆瓣会自动点开二维码面板）。
2. **被动**：不登录直接让 TA 逛，撞到登录墙时浏览工具会自动附上二维码（同上扫码即可）。

登录态持久在浏览器 profile 目录，之后服务重启、机器重启都不丢；过期了重复一次上面的流程（一两分钟）。二维码约 1-2 分钟过期，过期再要一张就行（30s 节流防刷）。

> 要求：浏览器以 `--remote-debugging-port=9223` 启动（部署脚本已带）；MCP 客户端需支持 image content 显示（如 Kelivo）。

## 部署（Linux 服务器，无头环境）

依赖：node ≥18、python3 ≥3.10、Xvfb、chromium、git。

```bash
# 1. 上游桥（本项目的浏览引擎）
git clone https://github.com/AZHi-xinxin/taobao-mcp-bridge.git ~/taobao-mcp-bridge
cd ~/taobao-mcp-bridge
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
npm ci --prefix ./runtime --ignore-scripts
# 慢网补丁：家宽到淘宝 CDN 抽风型慢时，空结果等待重读 + reload（强烈推荐）
git apply /path/to/taobao-shopping-mcp/patch/taobao-web-engine-slownet.patch

# 2. 下载 OpenCLI 扩展（v1.8.7 配套 v1.0.23）
mkdir -p extension && cd extension
curl -LO https://github.com/jackwener/OpenCLI/releases/download/v1.8.7/opencli-extension-v1.0.23.zip
unzip -o ext.zip 2>/dev/null || true

# 3. 常驻浏览器（Xvfb + chromium + 扩展 + 持久登录 profile）
Xvfb :98 -screen 0 1280x1024x24 -nolisten tcp &
DISPLAY=:98 chromium --user-data-dir=$HOME/taobao-profile \
  --load-extension=$HOME/taobao-mcp-bridge/extension \
  --remote-debugging-port=9223 --no-first-run --disable-dev-shm-usage \
  'https://login.taobao.com/member/login.jhtml' &

# 4. 本项目
git clone <this-repo> ~/taobao-shopping-mcp
cd ~/taobao-shopping-mcp
cp config.example.json config.json   # 改 token 和预算
openssl rand -base64 24 > ~/taobao-relay.token
cd ~/taobao-mcp-bridge && .venv/bin/python taobao_mcp_relay.py \
  --mode web --token-file $HOME/taobao-relay-token &
cd ~/taobao-shopping-mcp && node src/index.js &

# 5. 首次登录：浏览器里会显示淘宝登录二维码，用手机淘宝扫一次（登录态持久在 profile）
```

部署样例（systemd 单元：Xvfb / chromium / relay / mcp 四个服务）见 `deploy/`。

注册到你的 MCP 客户端：

```json
{ "type": "url", "name": "shopping",
  "url": "http://your-host:3980/mcp",
  "headers": { "Authorization": "Bearer <config.json 里的 token>" } }
```

> 公网暴露建议走 cloudflared tunnel / Tailscale，服务本身只监听 127.0.0.1。

## 设计立场

- **支付永远人工**：没有也不做任何下单/支付工具。真实加购（`shopping_cart_add`，默认关）也止步于"加入购物车"——结算按钮永远由人来点，这一条是本项目的存在前提
- **浏览受限**：底层桥（上游 taobao-mcp-bridge 公开版）只有 search/detail/看图/读已有购物车，没有写入淘宝的加购能力 —— 限制反而是特性
- **约束在代码不在提示词**：预算家规工具层强制，AI"撒娇"绕不过去
- **登录态是资产**：持久 profile + 二维码自动回传，掉线恢复成本 ≈ 扫一次码

### 风控现实（读我：代码已实测，行为差异来自环境）

**加购功能本身已端到端实测通过**（真实加入淘宝购物车，含 SKU 规格匹配）。能否顺利，取决于你的浏览器环境处于什么状态：

| 环境状态 | 表现 |
|---|---|
| **干净环境**（家宽 IP + 已登录 + 有正常浏览历史 + 低频操作） | 无滑块，预热后直达加购，一次成功 ✅ 实测 |
| **触发滑块时** | 自动拟人拖动（先快后慢 + 抖动 + **拖出最右端 overshoot**——人工实测该滑块必须拖过轨道右端才判过，v0.1.3 已修正）；仍拖不过时停手提示人工，可临时接 VNC 人工拖一次（x11vnc + noVNC 即可），冷却后重试也有效 |
| **惩罚态**（短时间高频自动化操作后） | 整个浏览器的商品页访问被拦（含普通浏览），通常几十分钟到几小时自动冷却，期间别硬试 |

给部署者的三条实操经验：

1. **首次先低频热身**：让 TA 先用浏览工具正常逛一会儿（搜几个商品、看几次详情），再第一次调 cart_add——上来就高频加购容易直接进惩罚态
2. **SKU 文案必须先查**：不传 sku 时很多商品会拒绝加购（页面要求选规格）。正确姿势：先用 `shopping_item_detail` 拿页面真实 SKU 文字（如"50ml （便携装）"），原样传给 cart_add
3. **家规就是风控策略**：maxAddsPerDay 限制的既是预算也是频率，默认 5 次/天是安全的
4. **账号维度惩罚是终极形态（实测教训）**：短时间大量自动化操作（尤其反复触滑块、反复登录）后，惩罚会升级到账号本身——此后换浏览器/换指纹/清 Cookie/滑块拖动全部无效，任何环境登录该账号都被拦。唯一解法是完全静置 48-72 小时（期间该账号不做任何自动化访问）。部署初期请用极低频率慢慢养

### 滑块人工兜底：noVNC 手动拖一次（实测有效）

自动拖动仍不过时，别硬试（每次失败都在加深风控标记）——把无头浏览器的虚拟屏幕投到浏览器里，人手动拖一次即可恢复：

```bash
# 服务器上（DISPLAY 对应你的浏览器 Xvfb，如 :98）
sudo apt install -y x11vnc novnc websockify
setsid x11vnc -display :98 -passwd <密码> -forever -shared -quiet &
setsid websockify --web /usr/share/novnc 0.0.0.0:6080 localhost:5900 &
# 本机浏览器打开 http://<服务器IP>:6080/vnc.html → 输密码 → 手动拖滑块
# 拖完立刻关闭：
pkill -f x11vnc; pkill -f websockify
```

注意（人工实测的坑）：阿里这款滑块看起来要拖到轨道最右端，**实际必须拖出最右端一点**才算通过——拖到头松手会报错。拖之前先用工具把商品页打开、停在滑块状态，再去连 VNC。

## 免责声明

本项目仅为个人学习与自动化研究，不是淘宝/支付宝/上游项目的官方产品。使用你自己的账号与登录态，遵守平台服务条款；触发风控（滑块/验证码）时上游会自动停止，请人工处理，不要对抗。商用/批量/抢购场景不在支持范围。

## 致谢与许可

- 浏览览引擎：[AZHi-xinxin/taobao-mcp-bridge](https://github.com/AZHi-xinxin/taobao-mcp-bridge)（MIT）及其上游 [OpenCLI](https://github.com/jackwener/opencli)
- 淘宝桌面版 MCP 路线参考：[Schrodingers-Neko/taobao-agent](https://github.com/Schrodingers-Neko/taobao-agent)
- 本仓库自写代码以 MIT 发布（见 LICENSE）；上游依赖遵循各自许可
