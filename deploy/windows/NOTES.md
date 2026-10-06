# Windows 部署注意事项（实战踩坑记录）

Windows 完全可以跑（上游 taobao-mcp-bridge 的维护者基线就是 Windows），但有四个 Linux 上没有的坑：

## 1. 千万别用 Microsoft Store 版 Python

Store 版（MSIX）有**文件写入虚拟化**：python 写 `%LOCALAPPDATA%` 等位置不落盘，只有 python 进程自己看得见——token 文件会"写了却读不到"，极难排查。请用 [python.org 官方安装包](https://www.python.org/downloads/windows/)。

判断方法：`python -c "import sys; print(sys.executable)"`——路径在 `WindowsApps` 或 `Program Files\WindowsApps` 下就是 Store 版。

## 2. 浏览器窗口不能最小化

桥的引擎要求页面 `visibilityState === visible`。Windows 上：

- ❌ 最小化 → 扩展 service worker 失活 + visibility=hidden
- ❌ 被其他最大化窗口完全遮挡 → Chromium 的窗口遮挡检测（CalculateNativeWinOcclusion）会判 hidden
- ✅ **窗口移到屏幕外**（start-all.ps1 已内置，SetWindowPos -30000,-30000）——桌面零干扰且保持 visible
- ⚠️ `--disable-features=CalculateNativeWinOcclusion` 这个开关在 Edge 上会被策略忽略并导致 `--load-extension` 失效（实测），别用

需要人工操作页面（扫码/过滑块）时，把脚本里的 -30000 改成 100 再跑一次，窗口就回来。

## 3. 常驻方式

没有 systemd，用登录计划任务：

```powershell
schtasks /create /tn TaobaoShopping /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\start-all.ps1" /sc onlogon
```

或者用 NSSM 把 node/python 注册为 Windows 服务（进阶）。

## 4. 路径与代理

- token 放 `$env:USERPROFILE\.taobao-shopping\relay.token`（脚本默认值）
- relay/mcp 都只监听 127.0.0.1，公网走 cloudflared（`cloudflared tunnel --url http://127.0.0.1:3980` 快速试用）
- 国内网络到 GitHub/CDN 慢：npm 用 `--registry=https://registry.npmmirror.com`，pip 用清华镜像

## 内存/自愈

Windows 上没有每周重启 timer 的等价物，chromium 会慢慢变胖。可以在计划任务里再加一个每周低峰跑 `Stop-Process` + 重跑 start-all.ps1 的任务（登录态在 profile 目录，重启零损失）。
