import { ENV } from './env.js';

export async function http(path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ENV.TIMEOUT_MS);

  try {
    const res = await fetch(path, { ...init, signal: controller.signal });
    const text = await res.text();

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
    }

    try { return JSON.parse(text); } catch { return text; }
  } finally {
    clearTimeout(timeout);
  }
}
