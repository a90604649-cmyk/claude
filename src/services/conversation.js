'use strict';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_CONTINUE_PROMPT = 'Continúa.';

function extractConversationId(input) {
  const value = String(input || '').trim();
  if (!value) return null;

  if (UUID_PATTERN.test(value)) return value.toLowerCase();

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const acceptedProtocol = parsed.protocol === 'https:' || parsed.protocol === 'http:' ||
    parsed.protocol === 'claude:';
  if (!acceptedProtocol || parsed.hostname.toLowerCase() !== 'claude.ai') return null;

  const match = parsed.pathname.match(/^\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i);
  return match ? match[1].toLowerCase() : null;
}

function buildConversationDeepLink(conversationId) {
  const id = extractConversationId(conversationId);
  if (!id) throw new Error('El ID de conversación no es válido.');

  return `claude://claude.ai/chat/${id}`;
}

module.exports = {
  DEFAULT_CONTINUE_PROMPT,
  UUID_PATTERN,
  extractConversationId,
  buildConversationDeepLink
};
