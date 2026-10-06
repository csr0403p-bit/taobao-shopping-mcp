# taobao-shopping-mcp Windows 一键启动（PowerShell 5.1+）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File start-all.ps1
# 幂等：每个环节在跑就跳过。路径按需修改下面三个变量。
$ErrorActionPreference = 'Continue'

# ── 按需修改 ──
$BRIDGE  = "$env:USERPROFILE\taobao-mcp-bridge"          # 上游桥目录
$HERE    = Split-Path -Parent $MyInvocation.MyCommand.Path   # 本目录 = 仓库根/deploy/windows 的上级
$ROOT    = Split-Path -Parent $HERE
$PROFILE = "$env:USERPROFILE\taobao-profile"             # 浏览器持久登录 profile
$TOKEN   = "$env:USERPROFILE\.taobao-shopping\relay.token"

# ── 1. 常驻浏览器（Edge 或 Chrome，装扩展；Windows 有 GUI，无需 Xvfb）──
# 关键：窗口不能最小化（扩展失活+页面 visibility=hidden），改为移到屏幕外 —— 桌面零干扰
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { $edge = 'C:\Program Files\Microsoft\Edge\Application\msedge.exe' }
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$browser = if (Test-Path $chrome) { $chrome } else { $edge }

$browserUp = Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" |
  Where-Object { $_.CommandLine -match [regex]::Escape($PROFILE) }
if (-not $browserUp) {
  New-Item -ItemType Directory -Force $TOKEN.Substring(0, $TOKEN.LastIndexOf('\')) | Out-Null
  Start-Process $browser -ArgumentList @(
    "--user-data-dir=$PROFILE",
    "--load-extension=$BRIDGE\extension",
    '--remote-debugging-port=9223',
    '--no-first-run','--no-default-browser-check','--disable-dev-shm-usage',
    'https://www.taobao.com')
  Start-Sleep -Seconds 12
}
# 把浏览器窗口移出屏幕（幂等）。需要人工扫码/看页面时把 -30000 改成 100 即可拉回
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinOffscreen {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
}
'@
Get-Process msedge, chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
  $cmd = (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $_.Id)).CommandLine
  if ($cmd -match [regex]::Escape($PROFILE)) {
    [WinOffscreen]::SetWindowPos($_.MainWindowHandle, [IntPtr]::Zero, -30000, -30000, 1280, 800, 0x0040) | Out-Null
  }
}

# ── 2. relay（python venv）──
if (-not (Get-NetTCPConnection -LocalPort 18126 -State Listen -ErrorAction SilentlyContinue)) {
  if (-not (Test-Path "$BRIDGE\.venv")) { Write-Output "先建 venv: python -m venv $BRIDGE\.venv 并 pip install -r requirements.txt"; exit 1 }
  Start-Process -WindowStyle Hidden "$BRIDGE\.venv\Scripts\python.exe" `
    -ArgumentList @("$BRIDGE\taobao_mcp_relay.py",'--mode','web','--token-file',$TOKEN) `
    -WorkingDirectory $BRIDGE
  Start-Sleep -Seconds 4
}

# ── 3. shopping-mcp（node）──
if (-not (Get-NetTCPConnection -LocalPort 3980 -State Listen -ErrorAction SilentlyContinue)) {
  Start-Process -WindowStyle Hidden node -ArgumentList @('src\index.js') -WorkingDirectory $ROOT
  Start-Sleep -Seconds 2
}

Write-Output '--- health ---'
try { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3980/health).Content } catch { Write-Output "shopping-mpc not up: $_" }
Write-Output '常驻建议：把本脚本注册为登录计划任务（schtasks /create /tn TaobaoShopping /tr "powershell -NoProfile -ExecutionPolicy Bypass -File <本脚本路径>" /sc onlogon）'
