# Claude Code Proxy

An OpenAI-compatible HTTP proxy that forwards requests to the Claude Code CLI. It spawns Claude Code in a real pseudo-terminal (PTY) and exposes a standard `POST /v1/chat/completions` endpoint so any OpenAI-compatible client (Cursor, Continue.dev, LiteLLM, custom scripts) can use it without modification.

## How it works

```
Client (OpenAI SDK / Cursor / etc.)
  → POST /v1/chat/completions
  → Proxy (Express HTTP server)
  → PTYSession (node-pty wrapping interactive `claude`)
      → writes prompt as keyboard input
      → monitors terminal screen buffer for response
      → streams clean text back as OpenAI SSE
  → X-Session-Id header returned for multi-turn reuse
```

Claude Code is spawned once per session and kept alive. Subsequent requests on the same session reuse the existing PTY process, which means Claude retains full conversation context natively without any message history manipulation.

---

## Prerequisites

- **Node.js** 18 or later
- **Claude Code CLI** installed and authenticated (`claude` available on PATH)
- On Windows: Visual Studio Build Tools (required for `node-pty` native compilation)
- On Linux/macOS: `python3`, `make`, and a C++ compiler (usually already present)

Verify Claude Code is working before starting the proxy:

```bash
claude --version
```

---

## Installation

```bash
npm install
npm run build
```

The `npm install` step compiles the `node-pty` native module. If it fails, see [node-pty troubleshooting](#node-pty-build-issues).

---

## Running

### Development (auto-reload on file changes)

```bash
npm run dev
```

### Production

```bash
npm run build
npm start
```

Both modes print:

```
Claude Code Proxy running at http://127.0.0.1:3000
Endpoint: http://127.0.0.1:3000/v1/chat/completions
Health:   http://127.0.0.1:3000/health
Models:   http://127.0.0.1:3000/v1/models
```

---

## Configuration

Copy `.env.example` to `.env` and edit as needed:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port to listen on |
| `HOST` | `127.0.0.1` | Host to bind (use `0.0.0.0` to expose on all interfaces) |
| `CLAUDE_PATH` | `claude` | Path to the Claude Code executable |
| `CLAUDE_TIMEOUT_MS` | `120000` | Max ms to wait for a response before returning a timeout error (2 minutes) |
| `SESSION_TTL_MS` | `600000` | How long an idle session is kept alive before being evicted (10 minutes) |
| `PROMPT_DEBOUNCE_MS` | `500` | Ms to wait after the status bar returns to idle before declaring the response complete |
| `DEBUG` | `false` | Set to `true` to print verbose PTY session logs |
| `PTY_DEBUG` | `false` | Set to `true` to print every raw PTY chunk, status bar state, and full screen dump on each response — like running debug-pty.js |

Environment variables can also be set inline without a `.env` file:

```bash
PORT=8080 DEBUG=true npm start
```

---

## API

The proxy implements a subset of the OpenAI Chat Completions API.

### `GET /health`

Returns server status and active session count.

```bash
curl http://localhost:3000/health
```

```json
{ "status": "ok", "version": "1.0.0", "sessions": 2 }
```

### `GET /v1/models`

Returns the list of available model IDs.

```bash
curl http://localhost:3000/v1/models
```

```json
{
  "object": "list",
  "data": [
    { "id": "claude-code", "object": "model", ... },
    { "id": "claude-sonnet", "object": "model", ... },
    { "id": "claude-haiku", "object": "model", ... },
    { "id": "claude-opus", "object": "model", ... }
  ]
}
```

### `POST /v1/chat/completions`

Standard OpenAI chat completions endpoint. Supports both streaming and non-streaming.

**Request headers:**

| Header | Description |
|---|---|
| `Content-Type` | `application/json` |
| `X-Session-Id` | *(optional)* Session UUID from a previous response. Reuses the same Claude PTY process for conversation continuity. |

**Response headers:**

| Header | Description |
|---|---|
| `X-Session-Id` | UUID identifying this session. Pass it back in subsequent requests to maintain conversation context. |

**Request body:**

```json
{
  "model": "claude-code",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello!" }
  ],
  "stream": false
}
```

The `model` field is accepted but ignored — all requests go to the local Claude Code CLI. Any of the listed model IDs work.

---

## Testing

### Health check

```bash
curl http://localhost:3000/health
```

### Non-streaming response

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-code",
    "messages": [{ "role": "user", "content": "Say hello in one sentence." }]
  }'
```

Expected:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "choices": [{
    "message": { "role": "assistant", "content": "Hello! How can I help you today?" },
    "finish_reason": "stop"
  }]
}
```

### Streaming response

```bash
curl -N -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-code",
    "stream": true,
    "messages": [{ "role": "user", "content": "Count to 5." }]
  }'
```

Expected: a series of `data: {...}` SSE lines followed by `data: [DONE]`.

### Multi-turn conversation (session reuse)

**Turn 1** — capture the session ID:

```bash
curl -i -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-code",
    "messages": [{ "role": "user", "content": "My name is Alice. Just say acknowledged." }]
  }'
```

Look for `X-Session-Id` in the response headers:

```
X-Session-Id: 9f9c81c4-b04f-4afc-8c81-e8f100a93142
```

**Turn 2** — reuse the session:

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: 9f9c81c4-b04f-4afc-8c81-e8f100a93142" \
  -d '{
    "model": "claude-code",
    "messages": [{ "role": "user", "content": "What is my name?" }]
  }'
```

Claude will answer "Alice" because the PTY session retains the full conversation history natively.

### Verbose debug output

To see every status bar change and response extraction step:

```bash
DEBUG=true npm start
```

---

## Connecting clients

### Cursor

1. Open **Cursor Settings → Models**
2. Add a custom OpenAI-compatible provider:
   - Base URL: `http://127.0.0.1:3000/v1`
   - API key: any non-empty string (e.g. `dummy`)
   - Model: `claude-code`

### Continue.dev

In `config.json`:

```json
{
  "models": [{
    "title": "Claude Code",
    "provider": "openai",
    "model": "claude-code",
    "apiBase": "http://127.0.0.1:3000/v1",
    "apiKey": "dummy"
  }]
}
```

### LiteLLM

```bash
litellm --model openai/claude-code --api_base http://127.0.0.1:3000/v1 --api_key dummy
```

### Python (openai SDK)

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3000/v1", api_key="dummy")

response = client.chat.completions.create(
    model="claude-code",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

---

## node-pty build issues

`node-pty` requires native compilation. If `npm install` fails:

**Windows:**

```bash
# Install VS Build Tools (if not already installed)
npm install --global windows-build-tools

# Or rebuild manually after installing VS Build Tools
npm rebuild node-pty
```

**Linux/macOS:**

```bash
# Debian/Ubuntu
sudo apt-get install -y python3 make g++

# macOS (Xcode CLT)
xcode-select --install

npm rebuild node-pty
```

---

## Graceful shutdown

Send `SIGINT` (Ctrl+C) or `SIGTERM` to cleanly kill all PTY sessions before the process exits. Abrupt termination leaves orphaned `claude` processes — use the signal handlers.
