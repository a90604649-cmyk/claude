'use strict';

const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const QUICK_ENTRY_TITLE = /what do you need|what can i help|qué necesitas|que necesitas|quick\s*(chat|entry|ask)|ask claude/i;

function isQuickEntryWindow(windowInfo) {
  const title = String(windowInfo.title || '');
  const width = Number(windowInfo.width) || 0;
  const height = Number(windowInfo.height) || 0;

  return QUICK_ENTRY_TITLE.test(title) || width < 620 || height < 420;
}

function selectMainClaudeWindow(windows) {
  const candidates = (Array.isArray(windows) ? windows : [])
    .filter((item) => {
      const width = Number(item.width) || 0;
      const height = Number(item.height) || 0;

      return item.visible === true
        && item.toolWindow !== true
        && item.owned !== true
        && width >= 620
        && height >= 420
        && !QUICK_ENTRY_TITLE.test(String(item.title || ''));
    });

  candidates.sort((a, b) => {
    const areaA = (Number(a.width) || 0) * (Number(a.height) || 0);
    const areaB = (Number(b.width) || 0) * (Number(b.height) || 0);
    const titleBonusA = /claude/i.test(String(a.title || '')) ? 100000 : 0;
    const titleBonusB = /claude/i.test(String(b.title || '')) ? 100000 : 0;
    const minimizedPenaltyA = a.minimized === true ? 10000 : 0;
    const minimizedPenaltyB = b.minimized === true ? 10000 : 0;

    return (areaB + titleBonusB - minimizedPenaltyB)
      - (areaA + titleBonusA - minimizedPenaltyA);
  });

  return candidates[0] || null;
}

async function runPowerShell(source) {
  if (process.platform !== 'win32') {
    return {
      supported: false,
      message: 'La activación de ventanas está disponible en Windows.'
    };
  }

  const encoded = Buffer.from(source, 'utf16le').toString('base64');

  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded
    ],
    {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024
    }
  );

  const output = stdout.trim();
  if (!output) {
    throw new Error('PowerShell no devolvió el resultado de la operación.');
  }

  return JSON.parse(output);
}

const ENUMERATE_WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'

$processes = @(Get-Process -Name 'Claude' -ErrorAction SilentlyContinue)
$processIds = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($process in $processes) {
  [void]$processIds.Add([int]$process.Id)
}

if ($processIds.Count -eq 0) {
  $response = [ordered]@{
    processFound = $false
    executablePath = $null
    windows = @()
  }
} else {
  $nativeCode = @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class AutoContinueWindowNative {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int index);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint command);
}
'@

  $null = Add-Type -TypeDefinition $nativeCode
  $script:claudeProcessIds = $processIds
  $script:claudeWindows = New-Object 'System.Collections.Generic.List[object]'

  $callback = [AutoContinueWindowNative+EnumWindowsProc] {
    param([IntPtr]$handle, [IntPtr]$lParam)

    [uint32]$windowProcessId = 0
    [void][AutoContinueWindowNative]::GetWindowThreadProcessId($handle, [ref]$windowProcessId)

    if ($script:claudeProcessIds.Contains([int]$windowProcessId)) {
      $rect = [AutoContinueWindowNative+RECT]::new()
      if ([AutoContinueWindowNative]::GetWindowRect($handle, [ref]$rect)) {
        $width = $rect.Right - $rect.Left
        $height = $rect.Bottom - $rect.Top

        if ($width -gt 0 -and $height -gt 0) {
          $titleBuilder = [System.Text.StringBuilder]::new(512)
          [void][AutoContinueWindowNative]::GetWindowText($handle, $titleBuilder, $titleBuilder.Capacity)

          $extendedStyle = [AutoContinueWindowNative]::GetWindowLong($handle, -20)
          $owner = [AutoContinueWindowNative]::GetWindow($handle, 4)

          $script:claudeWindows.Add([pscustomobject]@{
            handle = $handle.ToInt64().ToString()
            processId = [int]$windowProcessId
            title = $titleBuilder.ToString()
            width = $width
            height = $height
            visible = [AutoContinueWindowNative]::IsWindowVisible($handle)
            minimized = [AutoContinueWindowNative]::IsIconic($handle)
            toolWindow = (($extendedStyle -band 0x80) -ne 0)
            owned = ($owner -ne [IntPtr]::Zero)
          }) | Out-Null
        }
      }
    }

    return $true
  }

  [void][AutoContinueWindowNative]::EnumWindows($callback, [IntPtr]::Zero)

  $executablePath = ($processes | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_.Path)
  } | Select-Object -First 1).Path

  $response = [ordered]@{
    processFound = $true
    executablePath = $executablePath
    windows = @($script:claudeWindows.ToArray())
  }
}

ConvertTo-Json -InputObject $response -Compress -Depth 5
`;

function buildFocusScript(handle) {
  if (!/^\d+$/.test(String(handle))) {
    throw new Error('Identificador de ventana no válido.');
  }

  return String.raw`
$ErrorActionPreference = 'Stop'
$nativeCode = @'
using System;
using System.Runtime.InteropServices;

public static class AutoContinueFocusNative {
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
}
'@

$null = Add-Type -TypeDefinition $nativeCode
$handle = [IntPtr]::new([Int64]${handle})
[void][AutoContinueFocusNative]::ShowWindow($handle, 9)
[void][AutoContinueFocusNative]::BringWindowToTop($handle)
$focusRequested = [AutoContinueFocusNative]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 250
$foregroundConfirmed = ([AutoContinueFocusNative]::GetForegroundWindow() -eq $handle)

$response = [ordered]@{
  focusRequested = $focusRequested
  foregroundConfirmed = $foregroundConfirmed
}
ConvertTo-Json -InputObject $response -Compress
`;
}

function launchClaudeWithoutQuickEntry(executablePath) {
  if (!executablePath || typeof executablePath !== 'string') {
    return Promise.resolve(false);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getClaudeWindowSnapshot() {
  const scan = await runPowerShell(ENUMERATE_WINDOWS_SCRIPT);
  const windows = Array.isArray(scan.windows) ? scan.windows : [];

  return {
    processRunning: scan.processFound === true,
    executablePath: scan.executablePath || null,
    windows,
    quickEntryDetected: windows.some(isQuickEntryWindow),
    mainWindow: selectMainClaudeWindow(windows)
  };
}


function buildCloseScript(handle) {
  if (!/^\\d+$/.test(String(handle))) {
    throw new Error('Identificador de ventana no válido.');
  }

  return String.raw`
$ErrorActionPreference = 'Stop'
$nativeCode = @'
using System;
using System.Runtime.InteropServices;

public static class AutoContinueCloseNative {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
}
'@

$null = Add-Type -TypeDefinition $nativeCode
$handle = [IntPtr]::new([Int64]${handle})
$posted = [AutoContinueCloseNative]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
Start-Sleep -Milliseconds 300
$response = [ordered]@{
  closeRequested = $posted
  windowStillExists = [AutoContinueCloseNative]::IsWindow($handle)
}
ConvertTo-Json -InputObject $response -Compress
`;
}

async function closeClaudeMainWindow() {
  if (process.platform !== 'win32') {
    return { supported: false, closed: false, message: 'Cerrar la ventana de Claude está disponible en Windows.' };
  }

  const snapshot = await getClaudeWindowSnapshot();
  if (!snapshot.mainWindow) {
    return { supported: true, closed: false, message: 'No se encontró una ventana principal de Claude para cerrar.' };
  }

  const result = await runPowerShell(buildCloseScript(snapshot.mainWindow.handle));
  return {
    supported: true,
    closed: result.closeRequested === true,
    stillExists: result.windowStillExists === true,
    message: result.closeRequested === true
      ? 'Se solicitó cerrar la ventana principal que AutoContinue abrió para la comprobación.'
      : 'Windows no aceptó la solicitud para cerrar la ventana principal.'
  };
}

async function activateClaudeMainWindow() {
  if (process.platform !== 'win32') {
    return {
      supported: false,
      status: 'unsupported',
      message: 'La activación de la ventana principal está disponible en Windows.'
    };
  }

  try {
    let scan = await runPowerShell(ENUMERATE_WINDOWS_SCRIPT);
    let windows = Array.isArray(scan.windows) ? scan.windows : [];
    let quickEntryDetected = windows.some(isQuickEntryWindow);
    let mainWindow = selectMainClaudeWindow(windows);
    let launchAttempted = false;

    if (scan.processFound && !mainWindow && scan.executablePath) {
      try {
        launchAttempted = await launchClaudeWithoutQuickEntry(scan.executablePath);
        if (launchAttempted) {
          for (let attempt = 0; attempt < 8 && !mainWindow; attempt += 1) {
            await delay(500);
            scan = await runPowerShell(ENUMERATE_WINDOWS_SCRIPT);
            windows = Array.isArray(scan.windows) ? scan.windows : [];
            quickEntryDetected = windows.some(isQuickEntryWindow);
            mainWindow = selectMainClaudeWindow(windows);
          }
        }
      } catch {
        launchAttempted = false;
      }
    }

    if (!scan.processFound) {
      return {
        supported: true,
        status: 'not_running',
        quickEntryDetected: false,
        message: 'Claude Desktop no está abierto. No se ha enviado ningún mensaje.'
      };
    }

    if (!mainWindow) {
      return {
        supported: true,
        status: 'main_window_not_found',
        quickEntryDetected,
        launchAttempted,
        message: quickEntryDetected
          ? 'Se detectó la ventana pequeña. Se intentó abrir Claude normalmente, pero no apareció el chat principal. No se escribirá en la ventana pequeña.'
          : 'Claude está ejecutándose, pero no se encontró una ventana principal de chat visible.'
      };
    }

    const focus = await runPowerShell(buildFocusScript(mainWindow.handle));
    const foregroundConfirmed = focus.foregroundConfirmed === true;

    return {
      supported: true,
      status: foregroundConfirmed ? 'focused' : 'focus_failed',
      quickEntryDetected,
      launchAttempted,
      foregroundConfirmed,
      windowHandle: mainWindow.handle,
      window: {
        title: mainWindow.title,
        width: mainWindow.width,
        height: mainWindow.height,
        minimized: mainWindow.minimized === true
      },
      message: foregroundConfirmed
        ? 'La ventana principal de Claude está activa. La ventana pequeña no se utilizó.'
        : 'Se encontró el chat principal, pero Windows no confirmó que quedara en primer plano.'
    };
  } catch (error) {
    return {
      supported: true,
      status: 'error',
      message: 'No se pudo activar la ventana principal de Claude.',
      error: error.message
    };
  }
}

module.exports = {
  activateClaudeMainWindow,
  buildCloseScript,
  closeClaudeMainWindow,
  getClaudeWindowSnapshot,
  isQuickEntryWindow,
  selectMainClaudeWindow
};
