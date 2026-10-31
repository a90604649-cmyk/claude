'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildConversationDeepLink,
  extractConversationId
} = require('../src/services/conversation');

const ID = '550e8400-e29b-41d4-a716-446655440000';

test('accepts a bare conversation UUID', () => {
  assert.equal(extractConversationId(ID), ID);
});

test('accepts the official Claude web chat URL', () => {
  assert.equal(extractConversationId(`https://claude.ai/chat/${ID}`), ID);
});

test('accepts the official Claude deep link', () => {
  assert.equal(extractConversationId(`claude://claude.ai/chat/${ID}`), ID);
});

test('rejects share links, unrelated hosts, and malformed identifiers', () => {
  assert.equal(extractConversationId(`https://claude.ai/share/${ID}`), null);
  assert.equal(extractConversationId(`https://example.com/chat/${ID}`), null);
  assert.equal(extractConversationId('not-a-conversation'), null);
});

test('builds the documented deep link for the saved conversation', () => {
  assert.equal(buildConversationDeepLink(ID), `claude://claude.ai/chat/${ID}`);
  assert.throws(() => buildConversationDeepLink('invalid'));
});
