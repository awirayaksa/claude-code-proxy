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
      const prompt = extractText(messages[i].content);
      if (!prompt.trim()) throw new Error('User message is empty');
      return { prompt };
    }
  }

  throw new Error('No user message found in messages array');
}
