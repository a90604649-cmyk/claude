'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const DEFAULT_POLICY = Object.freeze({
  schoolScheduleEnabled: true,
  schoolStartTime: '13:00',
  schoolEndTime: '18:00',
  gameProtectionEnabled: true
});

function parseClock(value, fallback) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return parseClock(fallback, '13:00');
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return parseClock(fallback, '13:00');
  return hours * 60 + minutes;
}

function sanitizeExecutionPolicySettings(input = {}, current = DEFAULT_POLICY) {
  const next = {
    schoolScheduleEnabled: input.schoolScheduleEnabled === undefined
      ? current.schoolScheduleEnabled !== false
      : Boolean(input.schoolScheduleEnabled),
    schoolStartTime: String(input.schoolStartTime || current.schoolStartTime || DEFAULT_POLICY.schoolStartTime),
    schoolEndTime: String(input.schoolEndTime || current.schoolEndTime || DEFAULT_POLICY.schoolEndTime),
    gameProtectionEnabled: input.gameProtectionEnabled === undefined
      ? current.gameProtectionEnabled !== false
      : Boolean(input.gameProtectionEnabled)
  };

  const isValidClock = (value) => {
    const match = String(value).match(/^(\d{2}):(\d{2})$/);
    return Boolean(match && Number(match[1]) <= 23 && Number(match[2]) <= 59);
  };
  const start = parseClock(next.schoolStartTime, DEFAULT_POLICY.schoolStartTime);
  const end = parseClock(next.schoolEndTime, DEFAULT_POLICY.schoolEndTime);
  if (!isValidClock(next.schoolStartTime)
      || !isValidClock(next.schoolEndTime)
      || start >= end) {
    throw new Error('El horario escolar debe tener horas válidas y la hora de inicio debe ser anterior a la hora final.');
  }

  return next;
}

function getSchoolScheduleBlock(now = new Date(), settings = {}) {
  if (settings.schoolScheduleEnabled === false) return null;

  const day = now.getDay(); // 0 domingo; 1-5 lunes a viernes; 6 sábado.
  if (day < 1 || day > 5) return null;

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = parseClock(settings.schoolStartTime, DEFAULT_POLICY.schoolStartTime);
  const endMinutes = parseClock(settings.schoolEndTime, DEFAULT_POLICY.schoolEndTime);

  if (currentMinutes < startMinutes || currentMinutes >= endMinutes) return null;

  const start = settings.schoolStartTime || DEFAULT_POLICY.schoolStartTime;
  const end = settings.schoolEndTime || DEFAULT_POLICY.schoolEndTime;
  return {
    status: 'blocked_schedule',
    reason: 'school_schedule',
    message: `No se ejecutó: horario de clases activo (lunes a viernes, ${start}–${end}).`,
    localTime: now.toLocaleString()
  };
}

function identifyBlockingGame(processes = []) {
  for (const processInfo of processes) {
    const name = String(processInfo?.name || processInfo?.Name || '').split(/[\\/]/).pop();
    const commandLine = String(processInfo?.commandLine || processInfo?.CommandLine || '');

    if (/^sk[\s_-]*launcher\.exe$/i.test(name)) {
      return { id: 'sklauncher', name: 'SKLauncher', processName: name };
    }
    if (/^RobloxPlayerBeta\.exe$/i.test(name)) {
      return { id: 'roblox-player', name: 'Roblox Player', processName: name };
    }
    if (/^Minecraft(?:\.Windows)?\.exe$/i.test(name)) {
      return { id: 'minecraft', name: 'Minecraft', processName: name };
    }
    if (/^javaw?\.exe$/i.test(name)
        && /net\.minecraft|minecraft.*client|org\.lwjgl|--gameDir|--assetsDir/i.test(commandLine)) {
      return { id: 'minecraft-java', name: 'Minecraft (Java)', processName: name };
    }
  }

  // RobloxStudioBeta.exe is intentionally not included: Studio must not block recovery.
  return null;
}

const GAME_SCAN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object {
  $name = [string]$_.Name
  $line = [string]$_.CommandLine
  ($name -match '^(?i)sk[\s_-]*launcher\.exe$') -or
  ($name -match '^(?i)RobloxPlayerBeta\.exe$') -or
  ($name -match '^(?i)Minecraft(\.Windows)?\.exe$') -or
  (($name -match '^(?i)javaw?\.exe$') -and ($line -match '(?i)net\.minecraft|minecraft.*client|org\.lwjgl|--gameDir|--assetsDir'))
} | Select-Object -First 12 Name, CommandLine)

$response = @($processes | ForEach-Object {
  [ordered]@{ name = [string]$_.Name; commandLine = [string]$_.CommandLine }
})
ConvertTo-Json -InputObject $response -Compress -Depth 3
`;

async function detectBlockingGame() {
  if (process.platform !== 'win32') return null;

  const encoded = Buffer.from(GAME_SCAN_SCRIPT, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, timeout: 8000, maxBuffer: 512 * 1024 }
  );

  const output = stdout.trim();
  if (!output) throw new Error('Windows no devolvió la lista de procesos para comprobar los juegos.');
  const parsed = JSON.parse(output);
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return identifyBlockingGame(list);
}

module.exports = {
  DEFAULT_POLICY,
  detectBlockingGame,
  getSchoolScheduleBlock,
  identifyBlockingGame,
  sanitizeExecutionPolicySettings
};
