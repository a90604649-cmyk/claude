'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildInspectScript,
  parseResetTime,
  parseUsageLimitText
} = require('../src/services/limit-detector');

test('detects the English usage-limit notice and its reset time', () => {
  const now = new Date(2026, 9, 30, 12, 0, 0);
  const result = parseUsageLimitText(
    "Usage limit reached. You've reached your limit. Resets at 5:40 PM",
    now
  );

  assert.equal(result.blocked, true);
  assert.equal(result.resetAt, new Date(2026, 9, 30, 17, 40, 0).toISOString());
});

test('detects Spanish limit wording and a 24-hour reset time', () => {
  const now = new Date(2026, 9, 30, 12, 0, 0);
  const result = parseUsageLimitText(
    'Has alcanzado tu límite de uso. Se restablece a las 17:40',
    now
  );

  assert.equal(result.blocked, true);
  assert.equal(result.resetAt, new Date(2026, 9, 30, 17, 40, 0).toISOString());
});

test('rolls a reset time forward to tomorrow when it has already passed', () => {
  const now = new Date(2026, 9, 30, 18, 0, 0);
  const reset = parseResetTime('Resets at 5:40 PM', now);

  assert.equal(reset, new Date(2026, 9, 31, 17, 40, 0).toISOString());
});

test('does not classify an ordinary conversation as a usage limit', () => {
  const result = parseUsageLimitText('Claude is ready for your next question.');
  assert.equal(result.blocked, false);
  assert.equal(result.resetAt, null);
});

test('generates a PowerShell script only for a numeric window handle', () => {
  assert.match(buildInspectScript('123456'), /AutomationElement/);
  assert.throws(() => buildInspectScript('not-a-window'));
});
