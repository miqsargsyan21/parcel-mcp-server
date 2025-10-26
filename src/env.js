import 'dotenv/config';

export const ENV = {
  // Backend (your Express API)
  API_BASE_URL: process.env.PROJECTS_API_BASE_URL || 'http://localhost:3333',
  API_KEY: process.env.PROJECTS_API_KEY || '',
  TIMEOUT_MS: Number(process.env.MCP_HTTP_TIMEOUT_MS || 10000),

  // OpenAI
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',

  // HTTP bridge for your frontend
  MCP_HTTP_PORT: Number(process.env.MCP_HTTP_PORT || 4545)
};
