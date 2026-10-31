'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function checkClaudeProcess() {
  if (process.platform !== 'win32') {
    return {
      supported: false,
      running: null,
      checkedAt: new Date().toISOString(),
      message: 'La detección del proceso está preparada para Windows.'
    };
  }

  try {
    const { stdout } = await execFileAsync(
      'tasklist.exe',
      ['/FI', 'IMAGENAME eq Claude.exe', '/FO', 'CSV', '/NH'],
      {
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 1024 * 1024
      }
    );

    const running = /"Claude\.exe"/i.test(stdout);

    return {
      supported: true,
      running,
      checkedAt: new Date().toISOString(),
      message: running
        ? 'Claude Desktop está abierto.'
        : 'No se detectó Claude Desktop en ejecución.'
    };
  } catch (error) {
    return {
      supported: true,
      running: null,
      checkedAt: new Date().toISOString(),
      message: 'No se pudo comprobar el proceso de Claude Desktop.',
      error: error.message
    };
  }
}

module.exports = { checkClaudeProcess };
