import { execFileSync } from "node:child_process";

const ps = (script) =>
  execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();

const HELP = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class UA {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string title);
  public struct R { public int L,T,Rt,B; }
}
'@
$proc = Get-Process warehouse-ledger | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output "WINDOW_NOT_FOUND"; exit 1 }
$h = $proc.MainWindowHandle
[UA]::ShowWindow($h, 9) | Out-Null
[UA]::BringWindowToTop($h) | Out-Null
[UA]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 800
$r = New-Object UA+R
[UA]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Rt - $r.L
$ht = $r.B - $r.T
`;

function pixels(tag) {
  return ps(
    HELP +
      `
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save('E:\\2025\\Trae2\\crkgl-tauri2\\shots\\tauri-${tag}.png')
$body = $bmp.GetPixel([int]($w*0.5), [int]($ht*0.8))
$side = $bmp.GetPixel([int]($w*0.08), [int]($ht*0.45))
$bar  = $bmp.GetPixel([int]($w*0.5), 12)
Write-Output ("${tag}: ${'$'}($w)x${'$'}($ht) body=$($body.R),$($body.G),$($body.B) side=$($side.R),$($side.G),$($side.B) bar=$($bar.R),$($bar.G),$($bar.B)")
`,
  );
}

function clickAt(fx, fy) {
  return ps(
    HELP +
      `
$x = $r.L + [int]($w * ${fx})
$y = $r.T + [int]($ht * ${fy})
[UA]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 250
[UA]::mouse_event(0x0002, 0, 0, 0, 0)
[UA]::mouse_event(0x0004, 0, 0, 0, 0)
Start-Sleep -Milliseconds 500
Write-Output ("clicked ${'$'}x,${'$'}y")
`,
  );
}

console.log(pixels("d1"));
console.log(clickAt(0.0515, 0.9349));
await new Promise((r) => setTimeout(r, 1300));
console.log(pixels("l1"));
console.log(clickAt(0.0941, 0.9349));
await new Promise((r) => setTimeout(r, 1300));
console.log(pixels("d2"));
