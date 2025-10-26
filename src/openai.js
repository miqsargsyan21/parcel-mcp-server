import { ENV } from './env.js';

/**
 * Minimal OpenAI chat-completions wrapper using fetch.
 * Returns { raw, text } where text is the assistant message content.
 */
export async function callOpenAI({
  messages = [],
  model = ENV.OPENAI_MODEL,
  max_tokens = 512,
  temperature = 0.2
} = {}) {
  if (!ENV.OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY in environment');
  }

  const url = 'https://api.openai.com/v1/chat/completions';
  const body = { model, messages, max_tokens, temperature };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ENV.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI API error ${res.status}: ${text}`);
  }

  const json = JSON.parse(text);
  const reply = json?.choices?.[0]?.message?.content ?? '';
  return { raw: json, text: reply };
}
