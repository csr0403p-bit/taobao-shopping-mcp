# systemd 部署样例

四个单元（Xvfb / chromium / relay / mcp），把路径替换为你自己的：
- taobao-xvfb.service：Xvfb :98
- taobao-browser.service：chromium（扩展 + 持久 profile + CDP :9223）
- taobao-relay.service：taobao-mcp-bridge relay（:18126）
- shopping-mcp.service：本项目（:3980）

全部 User=<你的用户>、Restart=always、只监听 127.0.0.1。
浏览器内存随标签数增长，建议加一个每周低峰重启 timer（登录态在 profile，重启零损失）。
