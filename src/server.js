import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode
} from '@modelcontextprotocol/sdk/types.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from 'node:http';

import { ENV } from './env.js';
import { http } from './http.js';
import { callOpenAI } from './openai.js';

const text = (t) => [{ type: 'text', text: String(t) }];
const withApiKey = (headers = {}) =>
  ENV.API_KEY ? { ...headers, 'x-api-key': ENV.API_KEY } : headers;

function requireString(obj, key) {
  const v = obj?.[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`Missing or invalid "${key}"`);
  }
  return v.trim();
}
function hasNonEmptyString(obj, key) {
  return typeof obj?.[key] === 'string' && obj[key].trim() !== '';
}

/** --------------------------------
 *  In-memory conversational context
 *  --------------------------------*/
const memory = {
  lastProject: null,   // the most recently fetched project (projects.get)
  lastSearchItems: []  // array from the most recent projects.search
};

/** --------------------------------
 *  Robust list payload normalizer
 *  --------------------------------*/
function normalizeListPayload(result) {
  if (Array.isArray(result)) {
    return { items: result, total: result.length };
  }
  if (!result || typeof result !== 'object') {
    throw new Error('Invalid list payload: expected array or object');
  }
  const candidates = [
    { key: 'items', obj: result },
    { key: 'data', obj: result },
    { key: 'results', obj: result },
    { key: 'rows', obj: result },
    { key: 'projects', obj: result },
    { key: 'items', obj: result?.data }
  ];
  for (const { key, obj } of candidates) {
    if (obj && typeof obj === 'object' && Array.isArray(obj[key])) {
      const items = obj[key];
      const total = Number(obj.total ?? obj.count ?? obj.totalCount ?? items.length);
      return { items, total: Number.isFinite(total) ? total : items.length };
    }
  }
  // single object -> 1 row
  return { items: [result], total: 1 };
}

/** -------------------------------
 *  Tool registry (JSON Schemas)
 *  ------------------------------*/
const tools = [
  // AI helper
  {
    name: 'ai.summarize',
    description: 'Summarize any given text in 1–3 bullet points.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    }
  },

  // CRUD (aligned to backend at /api)
  {
    name: 'projects.create',
    description:
      'Create a project (projectName, address, zoningCode, zoneType, optional notes)',
    input_schema: {
      type: 'object',
      properties: {
        projectName: { type: 'string' },
        address: { type: 'string' },
        zoningCode: { type: 'string' },
        zoneType: { type: 'string' },
        notes: { type: 'string' }
      },
      required: ['projectName', 'address', 'zoningCode', 'zoneType']
    }
  },
  {
    name: 'projects.get',
    description:
      'Get a project by id OR projectName (if projectName is provided, server will search and get first match). Optionally summarizes notes if OpenAI key is set.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        projectName: { type: 'string' }
      },
      required: []
    }
  },
  {
    name: 'projects.update',
    description:
      'Update a project by id (partial fields). Uses PUT to match backend.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        projectName: { type: 'string' },
        address: { type: 'string' },
        zoningCode: { type: 'string' },
        zoneType: { type: 'string' },
        notes: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'projects.delete',
    description:
      'Delete a project by id OR by projectName. If neither is provided, will use last viewed project or the first item from the last search.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        projectName: { type: 'string' }
      },
      required: []
    }
  },
  {
    name: 'projects.deleteRandom',
    description:
      'Delete a random project: fetch a batch, choose one randomly, delete it, and return which one was deleted.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Batch size to sample from (default 25)' }
      },
      required: []
    }
  },
  {
    name: 'projects.search',
    description:
      'Search/filter via GET /api/projects using q, zoning_code, zone_type, address, city, state, plus page/limit.',
    input_schema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        zoning_code: { type: 'string' },
        zone_type: { type: 'string' },
        address: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        page: { type: 'number' },
        limit: { type: 'number' }
      }
    }
  }
];

/** --------------------------------
 *  Helpers that use backend
 *  --------------------------------*/
async function searchFirstByName(name) {
  const params = new URLSearchParams();
  params.set('q', String(name));
  params.set('limit', '1');
  const url = `${ENV.API_BASE_URL}/projects?${params.toString()}`;
  const result = await http(url, { headers: withApiKey() });
  const { items } = normalizeListPayload(result);
  return items[0] || null;
}

async function fetchSomeProjects(limit = 25) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  const url = `${ENV.API_BASE_URL}/projects?${params.toString()}`;
  const result = await http(url, { headers: withApiKey() });
  const { items } = normalizeListPayload(result);
  return items;
}

/** --------------------------------
 *  Run a tool (reusable function)
 *  --------------------------------*/
async function runTool(name, args = {}) {
  switch (name) {
    // AI
    case 'ai.summarize': {
      const input = requireString(args, 'text');
      if (!ENV.OPENAI_API_KEY) throw new Error('OpenAI is not configured. Set OPENAI_API_KEY in .env.');
      const prompt = [
        { role: 'system', content: 'You are a concise assistant. Summarize the text into 1–3 short bullet points.' },
        { role: 'user', content: input }
      ];
      const { text: summary } = await callOpenAI({ messages: prompt, max_tokens: 180 });
      return [{ type: 'text', text: summary }];
    }

    // CREATE
    case 'projects.create': {
      const projectName = requireString(args, 'projectName');
      const address = requireString(args, 'address');
      const zoningCode = requireString(args, 'zoningCode');
      const zoneType = requireString(args, 'zoneType');

      const body = JSON.stringify({
        projectName, address, zoningCode, zoneType,
        ...(args.notes ? { notes: String(args.notes) } : {})
      });

      const created = await http(`${ENV.API_BASE_URL}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...withApiKey() },
        body
      });

      memory.lastProject = created || null;
      return [{ type: 'json', json: created }];
    }

    // GET (id OR projectName)
    case 'projects.get': {
      let id = hasNonEmptyString(args, 'id') ? String(args.id) : null;

      if (!id && hasNonEmptyString(args, 'projectName')) {
        const found = await searchFirstByName(args.projectName);
        if (!found) throw new Error(`Project not found by name: ${args.projectName}`);
        id = String(found.id ?? found.projectId);
      }
      if (!id && memory.lastProject?.id) {
        id = String(memory.lastProject.id);
      }
      if (!id && memory.lastSearchItems?.[0]?.id) {
        id = String(memory.lastSearchItems[0].id);
      }
      if (!id) throw new Error('Provide either "id" or "projectName", or run a search/get first.');

      const project = await http(`${ENV.API_BASE_URL}/projects/${encodeURIComponent(id)}`, {
        headers: withApiKey()
      });

      if (ENV.OPENAI_API_KEY && project?.notes) {
        try {
          const prompt = [
            { role: 'system', content: 'You are a concise summarizer. Summarize the project notes into 1–2 sentences.' },
            { role: 'user', content: String(project.notes) }
          ];
          const { text: summary } = await callOpenAI({ messages: prompt, max_tokens: 120 });
          project.notes_summary = summary;
        } catch (e) {
          project.notes_summary_error = String(e?.message || e);
        }
      }

      memory.lastProject = project || null;
      return [{ type: 'json', json: project }];
    }

    // UPDATE (PUT)
    case 'projects.update': {
      const id = requireString(args, 'id');
      const body = JSON.stringify({
        ...(args.projectName ? { projectName: String(args.projectName) } : {}),
        ...(args.address ? { address: String(args.address) } : {}),
        ...(args.zoningCode ? { zoningCode: String(args.zoningCode) } : {}),
        ...(args.zoneType ? { zoneType: String(args.zoneType) } : {}),
        ...(args.notes ? { notes: String(args.notes) } : {})
      });

      const updated = await http(`${ENV.API_BASE_URL}/projects/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...withApiKey() },
        body
      });

      memory.lastProject = updated || null;
      return [{ type: 'json', json: updated }];
    }

    // DELETE (id OR projectName OR from context)
    case 'projects.delete': {
      let id = hasNonEmptyString(args, 'id') ? String(args.id) : null;
      let nameUsed = null;

      if (!id && hasNonEmptyString(args, 'projectName')) {
        nameUsed = String(args.projectName);
        const found = await searchFirstByName(nameUsed);
        if (!found) throw new Error(`Project not found by name: ${nameUsed}`);
        id = String(found.id ?? found.projectId);
      }
      // context fallbacks
      if (!id && memory.lastProject?.id) {
        id = String(memory.lastProject.id);
        nameUsed = memory.lastProject.projectName || nameUsed;
      }
      if (!id && memory.lastSearchItems?.[0]?.id) {
        id = String(memory.lastSearchItems[0].id);
        nameUsed = memory.lastSearchItems[0].projectName || nameUsed;
      }
      if (!id) throw new Error('Provide either "id" or "projectName", or run a search/get first.');

      await http(`${ENV.API_BASE_URL}/projects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: withApiKey()
      });

      memory.lastProject = null;
      const humanMsg = nameUsed
        ? `Deleted project "${nameUsed}" (id: ${id}).`
        : `Deleted project ${id}.`;

      return text(humanMsg);
    }

    // DELETE RANDOM
    case 'projects.deleteRandom': {
      const batchLimit = Number.isFinite(args.limit) ? Math.max(1, Number(args.limit)) : 25;
      const items = await fetchSomeProjects(batchLimit);
      if (!items.length) throw new Error('No projects available to delete.');
      const pick = items[Math.floor(Math.random() * items.length)];
      const id = String(pick.id ?? pick.projectId);
      const name = pick.projectName ?? pick.name ?? '(unnamed)';

      await http(`${ENV.API_BASE_URL}/projects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: withApiKey()
      });

      memory.lastProject = null;
      return text(`Deleted random project "${name}" (id: ${id}).`);
    }

    // SEARCH
    case 'projects.search': {
      const params = new URLSearchParams();
      for (const key of ['q', 'zoning_code', 'zone_type', 'address', 'city', 'state']) {
        if (args[key]) params.set(key, String(args[key]));
      }
      if (Number.isFinite(args.page)) params.set('page', String(args.page));
      if (Number.isFinite(args.limit)) params.set('limit', String(args.limit));

      const url = params.toString()
        ? `${ENV.API_BASE_URL}/projects?${params.toString()}`
        : `${ENV.API_BASE_URL}/projects`;

      const result = await http(url, { headers: withApiKey() });
      const payload = normalizeListPayload(result);

      // remember for context actions like "delete this"
      memory.lastSearchItems = payload.items || [];

      return [{ type: 'json', json: payload }];
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}

/** -------------------------------
 *  Human-friendly renderers
 *  ------------------------------*/
function mdEscape(s) {
  return String(s ?? '').replace(/\|/g, '\\|');
}

function renderSearch(json) {
  const { items = [], total = items.length } = json || {};
  if (!items.length) return 'No matching projects found.';
  const head = `| Project | Address | Zoning | Zone Type | ID |
|---|---|---|---|---|`;
  const rows = items.slice(0, 5).map((p) => {
    const name = p.projectName ?? p.name ?? '—';
    const addr = p.address ?? '—';
    const zc = p.zoningCode ?? p.zoning_code ?? '—';
    const zt = p.zoneType ?? p.zone_type ?? '—';
    const id = p.id ?? p.projectId ?? '—';
    return `| ${mdEscape(name)} | ${mdEscape(addr)} | ${mdEscape(zc)} | ${mdEscape(zt)} | \`${mdEscape(id)}\` |`;
  }).join('\n');

  const more = total > 5 ? `\n\n_Showing 5 of ${total} results._` : '';
  return `**Found ${total} project${total === 1 ? '' : 's'}**\n\n${head}\n${rows}${more}`;
}

function renderGet(project) {
  if (!project || typeof project !== 'object') return 'Project not found.';
  const lines = [
    `**${project.projectName ?? project.name ?? 'Project'}**`,
    `- **ID:** \`${project.id ?? '—'}\``,
    `- **Address:** ${project.address ?? '—'}`,
    `- **Zoning:** ${project.zoningCode ?? project.zoning_code ?? '—'}`,
    `- **Zone Type:** ${project.zoneType ?? project.zone_type ?? '—'}`,
  ];
  if (project.notes_summary) lines.push(`- **Notes (summary):** ${project.notes_summary}`);
  if (project.notes) lines.push(`<details><summary>Full notes</summary>\n\n${project.notes}\n\n</details>`);
  return lines.join('\n');
}

function renderCreate(updatedOrCreated) {
  const p = updatedOrCreated || {};
  return `✅ **Created project**: **${p.projectName ?? p.name ?? 'Project'}**  
- **ID:** \`${p.id ?? '—'}\`  
- **Address:** ${p.address ?? '—'}  
- **Zoning:** ${p.zoningCode ?? '—'}  
- **Zone Type:** ${p.zoneType ?? '—'}`;
}

function renderUpdate(updated) {
  const p = updated || {};
  return `✅ **Updated project**: **${p.projectName ?? p.name ?? 'Project'}**  
- **ID:** \`${p.id ?? '—'}\`  
- **Address:** ${p.address ?? '—'}  
- **Zoning:** ${p.zoningCode ?? '—'}  
- **Zone Type:** ${p.zoneType ?? '—'}`;
}

function renderDelete(msgParts) {
  const t = msgParts?.[0]?.text || 'Deleted.';
  return `✅ ${t}`;
}

function renderHumanFor(tool, content) {
  const first = Array.isArray(content) ? content[0] : null;

  switch (tool) {
    case 'projects.search': {
      const json = first?.json ?? null;
      return renderSearch(json);
    }
    case 'projects.get': {
      const json = first?.json ?? null;
      return renderGet(json);
    }
    case 'projects.create': {
      const json = first?.json ?? null;
      return renderCreate(json);
    }
    case 'projects.update': {
      const json = first?.json ?? null;
      return renderUpdate(json);
    }
    case 'projects.delete':
    case 'projects.deleteRandom': {
      return renderDelete(content);
    }
    case 'ai.summarize': {
      return first?.text || 'Done.';
    }
    default:
      if (first?.text) return first.text;
      if (first?.json) return '```json\n' + JSON.stringify(first.json, null, 2) + '\n```';
      return 'Done.';
  }
}

/** -------------------------------
 *  MCP stdio server (for ChatGPT)
 *  ------------------------------*/
const mcpServer = new Server(
  { name: 'parcel-projects-mcp', version: '1.6.0' },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const content = await runTool(req.params.name, req.params.arguments || {});
    return { content };
  } catch (err) {
    return { isError: true, content: text(err?.message || String(err)) };
  }
});

const transport = new StdioServerTransport();
mcpServer.connect(transport);

/** -----------------------------------
 *  Lightweight HTTP bridge for frontend
 *  ----------------------------------*/
const server = createServer(async (req, res) => {
  // CORS (allow local dev)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const send = (status, payload) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  };
  const readJson = () => new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } });
  });

  try {
    if (req.method === 'POST' && req.url === '/tool') {
      const { name, arguments: args } = await readJson();
      if (!name) return send(400, { error: 'Missing "name"' });
      const content = await runTool(String(name), args || {});
      const human = renderHumanFor(String(name), content);
      return send(200, { content, human });
    }

    if (req.method === 'POST' && req.url === '/chat') {
      if (!ENV.OPENAI_API_KEY) return send(400, { error: 'OpenAI not configured' });
      const { text: userText } = await readJson();
      if (!userText || typeof userText !== 'string') {
        return send(400, { error: 'Missing "text" in body' });
      }

      // LLM router -> {"tool":"...","arguments":{...}}
      const sys = 'You route user requests to one of these tools and return STRICT JSON only.';
      const toolsList = tools.map(t => `- ${t.name}: ${t.description}`).join('\n');
      const prompt = [
        { role: 'system', content: `${sys}\n\nTOOLS:\n${toolsList}\n\nNotes:\n- Deletions may use implicit context (last viewed or last search result) if no id/name provided.\n- There is a projects.deleteRandom tool.\n\nOutput EXACT JSON: {"tool":"<name>","arguments":{...}}` },
        { role: 'user', content: userText }
      ];

      const { text: toolPlanText } = await callOpenAI({ messages: prompt, max_tokens: 220, temperature: 0 });
      let plan;
      try {
        plan = JSON.parse(toolPlanText);
      } catch {
        const m = toolPlanText.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('Router did not return JSON');
        plan = JSON.parse(m[0]);
      }
      if (!plan?.tool) throw new Error('Router did not specify tool');

      // If router chose delete without args, it's fine—our tool will consult memory.
      const content = await runTool(String(plan.tool), plan.arguments || {});
      const human = renderHumanFor(String(plan.tool), content);
      return send(200, { plan, content, human });
    }

    send(404, { error: 'Not found' });
  } catch (e) {
    send(500, { error: String(e?.message || e) });
  }
});

server.listen(ENV.MCP_HTTP_PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[mcp-http] listening on http://localhost:${ENV.MCP_HTTP_PORT}`);
});
