'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildGameExitWatcherScript({
  executablePath,
  argumentsText = '--scheduled-check',
  workingDirectory
}) {
  if (!executablePath || !workingDirectory) {
    throw new Error('Falta la ruta de AutoContinue para vigilar el cierre de juegos.');
  }

  return String.raw`
$ErrorActionPreference = 'Stop'
$exe = ${psQuote(executablePath)}
$argsText = ${psQuote(argumentsText)}
$working = ${psQuote(workingDirectory)}

function Test-BlockingGame {
  $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  foreach ($item in $processes) {
    $name = [string]$item.Name
    $line = [string]$item.CommandLine

    if ($name -match '^(?i)SKLauncher\.exe$') { return $true }
    if ($name -match '^(?i)RobloxPlayerBeta\.exe$') { return $true }
    if ($name -match '^(?i)Minecraft(\.Windows)?\.exe$') { return $true }
    if (($name -match '^(?i)javaw?\.exe$') -and
        ($line -match '(?i)net\.minecraft|minecraft.*client|org\.lwjgl|--gameDir|--assetsDir')) {
      return $true
    }
  }
  return $false
}

# Subscribe before checking current processes to avoid a close-event race.
$queryText = "SELECT * FROM Win32_ProcessStopTrace WHERE ProcessName='SKLauncher.exe' OR ProcessName='RobloxPlayerBeta.exe' OR ProcessName='Minecraft.exe' OR ProcessName='Minecraft.Windows.exe' OR ProcessName='java.exe' OR ProcessName='javaw.exe'"
$watcher = New-Object System.Management.ManagementEventWatcher
$watcher.Query = New-Object System.Management.WqlEventQuery($queryText)
$watcher.Options.Timeout = [TimeSpan]::FromDays(1)
$watcher.Start()

try {
  if (-not (Test-BlockingGame)) {
    Start-Process -FilePath $exe -ArgumentList $argsText -WorkingDirectory $working
    exit 0
  }

  while ($true) {
    $null = $watcher.WaitForNextEvent()
    if (-not (Test-BlockingGame)) {
      Start-Process -FilePath $exe -ArgumentList $argsText -WorkingDirectory $working
      break
    }
  }
}
finally {
  try { $watcher.Stop() } catch {}
  $watcher.Dispose()
}
`;
}

function startGameExitWatcher(app) {
  if (process.platform !== 'win32') {
    return { supported: false, started: false, message: 'La espera por eventos de proceso está disponible en Windows.' };
  }

  const executablePath = process.execPath;
  const workingDirectory = app.isPackaged
    ? path.dirname(executablePath)
    : app.getAppPath();
  const argumentsText = app.isPackaged
    ? '--scheduled-check'
    : `"${app.getAppPath()}" --scheduled-check`;

  const script = buildGameExitWatcherScript({
    executablePath,
    argumentsText,
    workingDirectory
  });
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }
  );

  child.once('error', () => {});
  child.unref();
  return { supported: true, started: true, pid: child.pid || null };
}

module.exports = {
  buildGameExitWatcherScript,
  startGameExitWatcher
};
