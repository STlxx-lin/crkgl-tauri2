// 在真实 Tauri 窗口里点「浅色」，读回 WebView 内部状态。
// Tauri 开发构建没有远程调试端口，这里改用「窗口截图 + 像素取样」判断。
import { execFileSync } from "node:child_process";

const ps = (script) =>
  execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();

// 取窗口截图并采样几个像素
function sample() {
  return ps(`
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Cap {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  public struct R { public int L,T,Rt,B; }
}
'@
$p = Get-Process warehouse-ledger
$h = $p.MainWindowHandle
[Cap]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 500
$r = New-Object Cap+R
[Cap]::GetWindowRect($h, [ref]$r) | Out-Null
$bmp = New-Object System.Drawing.Bitmap ($r.Rt - $r.L), ($r.B - $r.T)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save('E:\\2025\\Trae2\\crkgl-tauri2\\shots\\tauri-theme.png')
$samples = @(
  @(400, 700),   # 内容区空白
  @(100, 400),   # 侧栏
  @(700, 60)     # 顶部标题栏
)
$out = foreach ($s in $samples) {
  $c = $bmp.GetPixel($s[0], $s[1])
  "{0},{1},{2}" -f $c.R, $c.G, $c.B
}
Write-Output ($out -join " ")
`);
}

// 点侧栏底部的「浅色」按钮：它固定在窗口左下角
function clickLight() {
  return ps(`
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Clk {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  public struct R { public int L,T,Rt,B; }
}
'@
$p = Get-Process warehouse-ledger
$h = $p.MainWindowHandle
[Clk]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400
$r = New-Object Clk+R
[Clk]::GetWindowRect($h, [ref]$r) | Out-Null
# 「浅色」按钮：窗口左侧栏底部，约 (56, 高度-62)
$x = $r.L + 56
$y = $r.B - 58
[Clk]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 150
[Clk]::mouse_event(0x0002, 0, 0, 0, 0)
[Clk]::mouse_event(0x0004, 0, 0, 0, 0)
Write-Output ("clicked " + $x + "," + $y)
`);
}

console.log("before:", sample());
console.log(clickLight());
await new Promise((r) => setTimeout(r, 1200));
console.log("after :", sample());
