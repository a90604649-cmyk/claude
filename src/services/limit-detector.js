'use strict';

const { getClaudeWindowSnapshot } = require('./claude-window');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const LIMIT_PATTERNS = [
  /usage limit reached/i,
  /you(?:'|’)ve reached your (?:\d+[- ]hour )?(?:usage |session )?limit/i,
  /you have reached your (?:\d+[- ]hour )?(?:usage |session )?limit/i,
  /you(?:'|’)ve hit your (?:usage )?limit/i,
  /reached your usage limit/i,
  /has alcanzado (?:tu|el) l[ií]mite/i,
  /l[ií]mite de uso alcanzad[oa]/i,
  /l[ií]mite de sesi[oó]n alcanzad[oa]/i,
  /te quedaste sin.{0,100}\\bmensajes?\\b/i,
  /sin\\s+mensajes?\\s+(?:gratuitos|gratis)/i
];

function parseResetTime(text, now = new Date()) {
  const value = String(text || '');
  const match = value.match(
    /(?:resets?|se restablece|se reinicia)(?:\s+(?:at|a(?:\s+las)?))?\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i
  );
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const rawMeridiem = match[3]?.toUpperCase().replace(/[.\\s]/g, '');
  const meridiem = rawMeridiem === 'AM' ? 'AM' : rawMeridiem === 'PM' ? 'PM' : undefined;

  if (minute > 59 || hour > 23 || (meridiem && (hour < 1 || hour > 12))) return null;

  if (meridiem === 'PM' && hour !== 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  if (!meridiem && hour <= 12) return null;

  const result = new Date(now);
  result.setHours(hour, minute, 0, 0);
  if (result.getTime() < now.getTime() - 60_000) {
    result.setDate(result.getDate() + 1);
  }

  return result.toISOString();
}

function parseUsageLimitText(text, now = new Date()) {
  const value = String(text || '');
  const matchedPattern = LIMIT_PATTERNS.find((pattern) => pattern.test(value));

  if (!matchedPattern) {
    return {
      blocked: false,
      resetAt: null,
      matchedText: null
    };
  }

  const matchedText = value.match(matchedPattern)?.[0] || 'usage limit reached';

  return {
    blocked: true,
    resetAt: parseResetTime(value, now),
    matchedText
  };
}

function buildInspectScript(handle) {
  if (!/^\d+$/.test(String(handle))) {
    throw new Error('Identificador de ventana no válido.');
  }

  return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$handle = [IntPtr]::new([Int64]${handle})
$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
if ($null -eq $root) {
  throw 'No se pudo acceder al árbol de controles de Claude.'
}

$elements = $root.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition
)

$textItems = New-Object 'System.Collections.Generic.List[string]'
$composerEnabled = $false
$composerTop = -1
$elementCount = [Math]::Min($elements.Count, 1800)

for ($index = 0; $index -lt $elementCount; $index++) {
  try {
    $element = $elements.Item($index)
    $current = $element.Current
    $name = [string]$current.Name

    if (-not [string]::IsNullOrWhiteSpace($name)) {
      $textItems.Add($name) | Out-Null
    }

    if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and $current.IsEnabled) {
      $bounds = $current.BoundingRectangle
      if ($bounds.Width -ge 240 -and $bounds.Height -ge 18 -and $bounds.Y -gt $composerTop) {
        $pattern = $null
        try {
          $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        } catch {
          $pattern = $null
        }

        if ($null -ne $pattern) {
          $currentValue = [string]$pattern.Current.Value
          if ([string]::IsNullOrWhiteSpace($currentValue)) {
            $composerEnabled = $true
            $composerTop = $bounds.Y
          }
        }
      }
    }
  } catch {
    # Some Chromium accessibility nodes disappear while the page updates.
  }
}

$response = [ordered]@{
  ok = $true
  text = [string]::Join([Environment]::NewLine, $textItems.ToArray())
  composerEnabled = $composerEnabled
  elementCount = $elementCount
}
ConvertTo-Json -InputObject $response -Compress -Depth 4
`;
}

async function inspectClaudeLimit(now = new Date()) {
  if (process.platform !== 'win32') {
    return {
      supported: false,
      processRunning: null,
      mainWindowFound: false,
      blocked: null,
      composerEnabled: false,
      message: 'La inspección visual de Claude está disponible en Windows.'
    };
  }

  try {
    const snapshot = await getClaudeWindowSnapshot();

    if (!snapshot.processRunning) {
      return {
        supported: true,
        processRunning: false,
        mainWindowFound: false,
        blocked: null,
        composerEnabled: false,
        message: 'Claude Desktop no está ejecutándose.'
      };
    }

    if (!snapshot.mainWindow) {
      return {
        supported: true,
        processRunning: true,
        mainWindowFound: false,
        quickEntryDetected: snapshot.quickEntryDetected,
        blocked: null,
        composerEnabled: false,
        message: 'No se encontró la ventana principal para inspeccionar el límite.'
      };
    }

    const script = buildInspectScript(snapshot.mainWindow.handle);
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
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
        timeout: 20000,
        maxBuffer: 2 * 1024 * 1024
      }
    );

    const ui = JSON.parse(stdout.trim());
    const accessibleText = String(ui.text || '').trim();
    const parsed = parseUsageLimitText(accessibleText, now);

    if (!accessibleText) {
      return {
        supported: true,
        processRunning: true,
        mainWindowFound: true,
        quickEntryDetected: snapshot.quickEntryDetected,
        blocked: null,
        resetAt: null,
        matchedText: null,
        composerEnabled: ui.composerEnabled === true,
        accessibleTextLength: 0,
        window: {
          title: snapshot.mainWindow.title,
          width: snapshot.mainWindow.width,
          height: snapshot.mainWindow.height
        },
        checkedAt: now.toISOString(),
        status: 'accessibility_text_empty',
        message: 'La ventana principal está abierta, pero Windows no expuso texto accesible. No se puede afirmar si hay límite o no.'
      };
    }

    const composerEnabled = ui.composerEnabled === true;
    const confidentlyClear = parsed.blocked === false && composerEnabled;

    return {
      supported: true,
      processRunning: true,
      mainWindowFound: true,
      quickEntryDetected: snapshot.quickEntryDetected,
      blocked: parsed.blocked === true ? true : confidentlyClear ? false : null,
      resetAt: parsed.resetAt,
      matchedText: parsed.matchedText,
      composerEnabled,
      accessibleTextLength: accessibleText.length,
      status: parsed.blocked
        ? 'limit_detected'
        : confidentlyClear
          ? 'no_limit'
          : 'indeterminate',
      window: {
        title: snapshot.mainWindow.title,
        width: snapshot.mainWindow.width,
        height: snapshot.mainWindow.height
      },
      checkedAt: now.toISOString(),
      message: parsed.blocked
        ? 'Claude muestra un aviso de límite de uso.'
        : confidentlyClear
          ? 'No se encontró un aviso de límite y el cuadro de mensaje está habilitado.'
          : 'No se encontró un aviso de límite, pero tampoco se pudo confirmar un cuadro de mensaje habilitado. El resultado es indeterminado.'
    };
  } catch (error) {
    const stderr = String(error.stderr || '').trim();
    const stdout = String(error.stdout || '').trim();
    const diagnostic = [error.message, stderr, stdout]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 1800);

    return {
      supported: true,
      processRunning: null,
      mainWindowFound: false,
      blocked: null,
      composerEnabled: false,
      message: 'No se pudo inspeccionar el estado de Claude.',
      error: diagnostic || 'Error sin detalle disponible.'
    };
  }
}

module.exports = {
  buildInspectScript,
  inspectClaudeLimit,
  parseResetTime,
  parseUsageLimitText
};
