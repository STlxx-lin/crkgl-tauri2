// 点进「基础资料」并截图（真实 Tauri 窗口，按窗口矩形换算坐标）。
import { execFileSync } from "node:child_process";

const ps = (script) =>
  execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();

const HELP = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class M1 {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e);
  public struct R { public int L,T,Rt,B; }
}
'@
$h = (Get-Process warehouse-ledger | Where-Object { $_.MainWindowHandle -ne 0 }).MainWindowHandle
[M1]::SetWindowPos($h, [IntPtr](-1), 40, 40, 1456, 939, 0x40) | Out-Null
[M1]::BringWindowToTop($h) | Out-Null
[M1]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 1400
$r = New-Object M1+R
[M1]::GetWindowRect($h, [ref]$r) | Out-Null
`;

function clickNav(index) {
  // 导航行高 36，第一项在客户区 y≈136；客户区原点 = 窗口 + (8, 31)
  const y = 132 + (index - 1) * 36;
  return ps(
    HELP +
      `
$x = $r.L + 8 + 100
$y = $r.T + 31 + ${y}
[M1]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 250
[M1]::mouse_event(0x0002,0,0,0,0); [M1]::mouse_event(0x0004,0,0,0,0)
Start-Sleep -Milliseconds 1600
Write-Output ("clicked row ${index} at " + $x + "," + $y)
`,
  );
}

function shot(name) {
  return ps(
    HELP +
      `
$bmp = New-Object System.Drawing.Bitmap ($r.Rt-$r.L), ($r.B-$r.T)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save('E:\\2025\\Trae2\\crkgl-tauri2\\shots\\${name}.png')
Write-Output "saved ${name}"
`,
  );
}

// 导航顺序：台账(1) 开单(2) 基础资料(3) 汇总(4) 导入(5) 只读站(6)
console.log(clickNav(3));
console.log(shot("master-items"));
