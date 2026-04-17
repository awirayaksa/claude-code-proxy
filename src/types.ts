// ─── OpenAI protocol types ───────────────────────────────────────────────────

export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  user?: string;
  stream_options?: { include_usage?: boolean };
}

export interface DeltaContent {
  role?: string;
  content?: string;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: [{
    index: 0;
    delta: DeltaContent;
    finish_reason: string | null;
  }];
  usage?: UsageStats;
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: [{
    index: 0;
    message: { role: string; content: string };
    finish_reason: string;
  }];
  usage: UsageStats;
}

export interface UsageStats {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ─── Session / PTY types ─────────────────────────────────────────────────────

export interface SessionRequest {
  prompt: string;
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
  timeoutMs: number;
}

export type PTYSessionState = 'starting' | 'ready' | 'busy' | 'dead';

// ─── Parsed message result ────────────────────────────────────────────────────

export interface ParsedMessages {
  prompt: string;
}
