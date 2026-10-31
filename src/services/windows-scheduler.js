'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const TASK_NAME = 'ClaudeAutoContinue-Recovery';

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildScheduleTaskScript({
  executablePath,
  argumentsText = '--scheduled-check',
  workingDirectory,
  dueAt
}) {
  if (!executablePath || !workingDirectory) {
    throw new Error('Falta la ruta de AutoContinue para programar la comprobación.');
  }

  const timestamp = new Date(dueAt);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error('La fecha de la próxima comprobación no es válida.');
  }

  const iso = timestamp.toISOString();
  return String.raw`
$ErrorActionPreference = 'Stop'
$taskName = ${psQuote(TASK_NAME)}
$exe = ${psQuote(executablePath)}
$argsText = ${psQuote(argumentsText)}
$working = ${psQuote(workingDirectory)}
$dueUtc = [DateTimeOffset]::Parse(${psQuote(iso)})
$dueLocal = $dueUtc.LocalDateTime
if ($dueLocal -le (Get-Date)) {
  $dueLocal = (Get-Date).AddMinutes(1)
}

$action = New-ScheduledTaskAction -Execute $exe -Argument $argsText -WorkingDirectory $working
$trigger = New-ScheduledTaskTrigger -Once -At $dueLocal
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

[ordered]@{
  scheduled = $true
  taskName = $taskName
  dueAtLocal = $dueLocal.ToString('yyyy-MM-dd HH:mm:ss')
} | ConvertTo-Json -Compress
`;
}

function buildRemoveTaskScript() {
  return String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
'RE,'
`.replace("'RE,'", "'REMOVED'");
}

async function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, timeout: 15000, maxBuffer: 512 * 1024 }
  );
  return stdout.trim();
}

async function scheduleRecoveryTask(app, dueAt) {
  if (process.platform !== 'win32') {
    return { supported: false, scheduled: false, message: 'El Programador de tareas está disponible en Windows.' };
  }

  const executablePath = process.execPath;
  const workingDirectory = app.isPackaged
    ? path.dirname(executablePath)
    : app.getAppPath();
  const argumentsText = app.isPackaged
    ? '--scheduled-check'
    : `"${app.getAppPath()}" --scheduled-check`;

  const script = buildScheduleTaskScript({
    executablePath,
    argumentsText,
    workingDirectory,
    dueAt
  });

  const output = await runPowerShell(script);
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error(output || 'Windows no confirmó la creación de la tarea programada.');
  }

  if (result.scheduled !== true) {
    throw new Error('Windows no confirmó la creación de la tarea programada.');
  }
  return { supported: true, ...result };
}

async function removeRecoveryTask() {
  if (process.platform !== 'win32') return { supported: false, removed: false };
  await runPowerShell(buildRemoveTaskScript());
  return { supported: true, removed: true };
}

module.exports = {
  TASK_NAME,
  buildRemoveTaskScript,
  buildScheduleTaskScript,
  removeRecoveryTask,
  scheduleRecoveryTask
};
