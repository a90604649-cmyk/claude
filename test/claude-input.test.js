'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSendScript } = require('../src/services/claude-input');

test('builds a Unicode-safe message script for a numeric Claude window handle', () => {
  const prompt = 'Continúa la tarea. Conserva los avances y revisa el contexto.';
  const script = buildSendScript('987654', prompt);
  const encodedPrompt = Buffer.from(prompt, 'utf16le').toString('base64');

  assert.match(script, /AutomationElement/);
  assert.match(script, /SendInput/);
  assert.ok(script.includes(encodedPrompt));
  assert.ok(!script.includes(prompt));
});

test('rejects invalid handles, blank text, and oversized messages', () => {
  assert.throws(() => buildSendScript('not-a-handle', 'Continue'));
  assert.throws(() => buildSendScript('123', '   '));
  assert.throws(() => buildSendScript('123', 'x'.repeat(2001)));
});
