'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function buildSendScript(handle, message) {
  if (!/^\d+$/.test(String(handle))) {
    throw new Error('Identificador de ventana no válido.');
  }
  if (typeof message !== 'string' || !message.trim() || message.length > 2000) {
    throw new Error('El mensaje de continuación está vacío o supera 2000 caracteres.');
  }

  const encodedMessage = Buffer.from(message, 'utf16le').toString('base64');

  return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$nativeCode = @'
using System;
using System.Runtime.InteropServices;

public static class AutoContinueInputNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION {
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public MOUSEINPUT mi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public INPUTUNION U;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint count, INPUT[] inputs, int size);

    public static void SendUnicode(string value) {
        foreach (char character in value) {
            INPUT down = new INPUT();
            down.type = 1;
            down.U.ki.wScan = character;
            down.U.ki.dwFlags = 0x0004;

            INPUT up = new INPUT();
            up.type = 1;
            up.U.ki.wScan = character;
            up.U.ki.dwFlags = 0x0004 | 0x0002;

            INPUT[] pair = new INPUT[] { down, up };
            uint sent = SendInput(2, pair, Marshal.SizeOf(typeof(INPUT)));
            if (sent != 2) throw new InvalidOperationException("No se pudieron introducir todos los caracteres.");
        }
    }

    public static void PressEnter() {
        INPUT down = new INPUT();
        down.type = 1;
        down.U.ki.wVk = 0x0D;

        INPUT up = new INPUT();
        up.type = 1;
        up.U.ki.wVk = 0x0D;
        up.U.ki.dwFlags = 0x0002;

        INPUT[] pair = new INPUT[] { down, up };
        uint sent = SendInput(2, pair, Marshal.SizeOf(typeof(INPUT)));
        if (sent != 2) throw new InvalidOperationException("No se pudo enviar la tecla Enter.");
    }
}
'@

$null = Add-Type -TypeDefinition $nativeCode
$handle = [IntPtr]::new([Int64]${handle})
$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
if ($null -eq $root) {
  throw 'No se pudo acceder a la ventana principal.'
}

$elements = $root.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition
)

$composer = $null
$composerTop = -1
for ($index = 0; $index -lt [Math]::Min($elements.Count, 1800); $index++) {
  try {
    $element = $elements.Item($index)
    $current = $element.Current

    if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and $current.IsEnabled) {
      $bounds = $current.BoundingRectangle
      if ($bounds.Width -ge 240 -and $bounds.Height -ge 18 -and $bounds.Y -gt $composerTop) {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $currentValue = [string]$pattern.Current.Value
        if ([string]::IsNullOrWhiteSpace($currentValue)) {
          $composer = $element
          $composerTop = $bounds.Y
        }
      }
    }
  } catch {
    # Ignore inaccessible or non-value controls.
  }
}

if ($null -eq $composer) {
  $response = [ordered]@{
    sent = $false
    status = 'composer_not_ready'
    message = 'No se encontró un cuadro de mensaje vacío y habilitado. No se escribió nada.'
  }
} else {
  $composer.SetFocus()
  Start-Sleep -Milliseconds 250

  $messageBytes = [Convert]::FromBase64String('${encodedMessage}')
  $message = [System.Text.Encoding]::Unicode.GetString($messageBytes)

  [AutoContinueInputNative]::SendUnicode($message)
  Start-Sleep -Milliseconds 300
  [AutoContinueInputNative]::PressEnter()
  Start-Sleep -Milliseconds 400

  $response = [ordered]@{
    sent = $true
    status = 'submitted'
    message = 'Se envió el mensaje de continuación al cuadro vacío de Claude.'
  }
}

ConvertTo-Json -InputObject $response -Compress -Depth 4
`;
}

async function sendContinuationMessage(handle, message) {
  if (process.platform !== 'win32') {
    return {
      sent: false,
      status: 'unsupported',
      message: 'El envío automático está disponible en Windows.'
    };
  }

  try {
    const script = buildSendScript(handle, message);
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
        maxBuffer: 1024 * 1024
      }
    );

    return JSON.parse(stdout.trim());
  } catch (error) {
    return {
      sent: false,
      status: 'error',
      message: 'No se pudo enviar el mensaje de continuación.',
      error: error.message
    };
  }
}

module.exports = { buildSendScript, sendContinuationMessage };
