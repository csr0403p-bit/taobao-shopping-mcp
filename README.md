# taobao-shopping-mcp

让你的 AI 伴侣自己逛淘宝：她会搜索、比价、把心动的东西收进**自己的心愿单**、向你请示，然后把"待加购清单"递给你 —— **加购物车和付款永远由人类完成**，AI 碰不到钱。

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

## 工具面（9 个，全部 `shopping_` 前缀）

| 工具 | 语义 |
|---|---|
| `shopping_browse(keyword)` | 逛街：搜商品，返回标题+链接（≤10 条） |
| `shopping_item_detail(itemId/url)` | 凑近看：真实价格 / SKU / 店铺（搜索页价格是起步价，比价必看这里） |
| `shopping_collect(...)` | 心动了：收进心愿单（带理由） |
| `shopping_ask_for(wishId, message)` | 请示：正式请求购买，生成给主人的话术 |
| `shopping_add_to_cart(wishId)` | 过家规校验后标记"待主人加购"，返回商品链接 + 话术（**不会自动下单**） |
| `shopping_my_wishes(status?)` | 翻自己的心愿单 |
| `shopping_pay_link()` | 汇总"给主人的清单"（链接 + 理由），人类点开 → 加购 → 付款 |
| `shopping_check_gifts()` | 按心愿关键词只读检索淘宝购物车："你有没有偷偷给我买" |
| `shopping_ping()` | 通道自检 |

### 心愿单状态机

```
want(想要) → asked(已请示) → carted(待加购) → paid(已支付) → delivered(已送达)
                │                                 ↑
                └────────── declined(被婉拒) ─────┘
```

心愿单是 **AI 自己的**购物车（`data/wishlist.json`），与你淘宝账号里的真实购物车完全隔离 —— 她收藏 20 个毛绒玩具也不会污染你的日常采购清单。

### 家规硬约束（`config.json → policy`）

| 规则 | 默认 | 行为 |
|---|---|---|
| `perItemAskLimit` | 200 | 单件超过必须先 `ask_for` 才允许 `add_to_cart` |
| `monthlyBudget` | 1000 | 本月预估总额超预算直接拒绝 |
| `maxAddsPerDay` | 5 | 每日加购次数上限 |

约束在工具层强制执行 —— 模型想绕也绕不过，被拦截时返回"先和主人商量吧"。

### 登录态过期自动回码

浏览类工具被登录墙拦截时，服务自动经 CDP 把浏览器带到对应登录页、截图，把二维码作为 **MCP image content** 附在返回里。支持 MCP image 的客户端（如 [Kelivo](https://github.com/kelivo-com/kelivo)）会直接在聊天窗口显示 —— 扫一下，跟 AI 说声"扫好了"，继续逛。30s 节流防反复截图。

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

- **支付永远人工**：没有也不做任何下单/支付工具。`add_to_cart` 的语义是"把链接递给人类"，这一条是本项目的存在前提
- **浏览受限**：底层桥（上游 taobao-mcp-bridge 公开版）只有 search/detail/看图/读已有购物车，没有写入淘宝的加购能力 —— 限制反而是特性
- **约束在代码不在提示词**：预算家规工具层强制，AI"撒娇"绕不过去
- **登录态是资产**：持久 profile + 二维码自动回传，掉线恢复成本 ≈ 扫一次码

## 免责声明

本项目仅为个人学习与自动化研究，不是淘宝/支付宝/上游项目的官方产品。使用你自己的账号与登录态，遵守平台服务条款；触发风控（滑块/验证码）时上游会自动停止，请人工处理，不要对抗。商用/批量/抢购场景不在支持范围。

## 致谢与许可

- 浏览览引擎：[AZHi-xinxin/taobao-mcp-bridge](https://github.com/AZHi-xinxin/taobao-mcp-bridge)（MIT）及其上游 [OpenCLI](https://github.com/jackwener/opencli)
- 淘宝桌面版 MCP 路线参考：[Schrodingers-Neko/taobao-agent](https://github.com/Schrodingers-Neko/taobao-agent)
- 本仓库自写代码以 MIT 发布（见 LICENSE）；上游依赖遵循各自许可
