import { spawn, ChildProcess } from 'node:child_process';
import { log } from './logger';

export interface ProbeState {
  obs: boolean;
  fs: boolean;
}

// loop persistente em PowerShell: detecta OBS aberto e janela em tela cheia
const PS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class FS {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public struct RECT { public int L; public int T; public int R; public int B; }
}
'@
$ignore = @('explorer', 'Hermes Assistente', 'electron', 'dwm', '')
while ($true) {
  $obs = [bool](Get-Process obs64 -ErrorAction SilentlyContinue)
  $fs = $false
  try {
    $h = [FS]::GetForegroundWindow()
    $r = New-Object FS+RECT
    [FS]::GetWindowRect($h, [ref]$r) | Out-Null
    $procId = [uint32]0
    [FS]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    $pname = try { (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { '' }
    if ($pname -notin $ignore) {
      foreach ($scr in [System.Windows.Forms.Screen]::AllScreens) {
        $b = $scr.Bounds
        if ($r.L -le $b.X -and $r.T -le $b.Y -and $r.R -ge ($b.X + $b.Width) -and $r.B -ge ($b.Y + $b.Height)) { $fs = $true }
      }
    }
  } catch {}
  [pscustomobject]@{ obs = $obs; fs = $fs } | ConvertTo-Json -Compress
  Start-Sleep -Seconds 5
}
`;

let proc: ChildProcess | null = null;

export function startProbe(onState: (state: ProbeState) => void): void {
  proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  let buffer = '';
  proc.stdout?.on('data', (d) => {
    buffer += String(d);
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      try {
        onState(JSON.parse(line) as ProbeState);
      } catch {
        // linha corrompida — ignora
      }
    }
  });
  proc.on('error', (err) => log(`[probe] erro: ${err.message}`));
  proc.on('exit', (code) => log(`[probe] encerrou (${code})`));
}

export function stopProbe(): void {
  if (proc && !proc.killed) proc.kill();
  proc = null;
}
