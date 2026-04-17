import { Router } from 'express';

export const modelsRouter = Router();

const MODELS = [
  { id: 'claude-code',    description: 'Claude Code (default model)' },
  { id: 'claude-sonnet',  description: 'Claude Sonnet' },
  { id: 'claude-haiku',   description: 'Claude Haiku' },
  { id: 'claude-opus',    description: 'Claude Opus' },
];

modelsRouter.get('/models', (_req, res) => {
  res.json({
    object: 'list',
    data: MODELS.map((m) => ({
      id: m.id,
      object: 'model',
      created: 1700000000,
      owned_by: 'anthropic',
    })),
  });
});
