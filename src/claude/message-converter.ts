import { OpenAIMessage, ContentPart, ParsedMessages } from '../types';

/**
 * Extract plain text from an OpenAI message content field,
 * which can be either a string or an array of content parts.
 */
export function extractText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('');
}

/**
 * Some clients (e.g. agent frameworks) pack the full conversation history into
 * a single user message as "User: … Assistant: … User: <latest>".
 * Detect that pattern and return only the last User turn, so we never feed the
 * entire history as a raw prompt to Claude Code's interactive REPL.
 */
function extractLastUserTurnIfHistory(text: string): string {
  // Need at least one full User+Assistant exchange to qualify as history
  if (!/User:[\s\S]+?Assistant:/i.test(text)) return text;

  const lastUserIdx = text.lastIndexOf('User:');
  if (lastUserIdx === -1) return text;

  const after = text.slice(lastUserIdx + 5).trim();
  // Stop at the next "Assistant:" if somehow present
  const assistantIdx = after.search(/\s+Assistant:/i);
  const extracted = (assistantIdx !== -1 ? after.slice(0, assistantIdx) : after).trim();
  return extracted || text;
}

/**
 * Extract only the last user message text from an OpenAI messages[] array.
 * System messages, history, and other roles are ignored — the PTY session
 * already maintains conversation context natively inside the Claude process.
 */
export function convertMessages(messages: OpenAIMessage[]): ParsedMessages {
  if (!messages || messages.length === 0) {
    throw new Error('messages array is empty');
  }

  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const raw = extractText(messages[i].content);
      if (!raw.trim()) throw new Error('User message is empty');
      const prompt = extractLastUserTurnIfHistory(raw);
      return { prompt };
    }
  }

  throw new Error('No user message found in messages array');
}
