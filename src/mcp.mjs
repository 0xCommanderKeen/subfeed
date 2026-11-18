import { readBody, sendJson } from './http-io.mjs';

const LATEST_PROTOCOL_VERSION = '2025-06-18';
const PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-03-26', '2024-11-05'];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const TYPES = {
  string: [(v) => typeof v === 'string', 'a string'],
  boolean: [(v) => typeof v === 'boolean', 'true or false'],
  integer: [Number.isInteger, 'a whole number'],
  number: [Number.isFinite, 'a number'],
  array: [Array.isArray, 'a list'],
  object: [(v) => v !== null && typeof v === 'object' && !Array.isArray(v), 'an object'],
};

function valueError(schema, value, name) {
  const type = TYPES[schema.type];
  if (type && !type[0](value)) return `${name} must be ${type[1]}`;
  if (schema.enum && !schema.enum.includes(value)) return `${name} must be one of ${schema.enum.join(', ')}`;
  if (typeof value === 'number' && value < schema.minimum) return `${name} must be at least ${schema.minimum}`;
  if (typeof value === 'number' && value > schema.maximum) return `${name} must be at most ${schema.maximum}`;
  if (typeof value === 'string' && value.length > schema.maxLength) return `${name} must be at most ${schema.maxLength} characters`;
  if (schema.items && Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const error = valueError(schema.items, item, `${name}[${i}]`);
      if (error) return error;
    }
  }
  return null;
}

function argumentsError({ name, inputSchema }, args) {
  const { properties = {}, required = [], additionalProperties } = inputSchema;
  const missing = required.find((key) => !Object.hasOwn(args, key));
  if (missing) return `${missing} is required`;
  const unknown = additionalProperties === false && Object.keys(args).find((key) => !Object.hasOwn(properties, key));
  if (unknown) {
    const keys = Object.keys(properties);
    return `unknown argument ${unknown}; ${name} ${keys.length ? `takes ${keys.join(', ')}` : 'takes no arguments'}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const error = Object.hasOwn(properties, key) && valueError(properties[key], value, key);
    if (error) return error;
  }
  return null;
}

const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });

// A tool that throws answers a normal result with isError, so the model reads the message; JSON-RPC errors are for protocol faults.
function rpcMethods({ name, version, instructions, tools }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    initialize: (params) => ({
      protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : LATEST_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name, version },
      ...(instructions ? { instructions } : {}),
    }),
    ping: () => ({}),
    'tools/list': () => ({ tools: tools.map(({ run, ...tool }) => tool) }),
    'tools/call': async (params) => {
      const tool = byName.get(params?.name);
      if (!tool) throw new RpcError(INVALID_PARAMS, `unknown tool ${params?.name}`);
      const args = params.arguments ?? {};
      if (typeof args !== 'object' || Array.isArray(args)) throw new RpcError(INVALID_PARAMS, 'arguments must be an object');
      const invalid = argumentsError(tool, args);
      if (invalid) return toolError(invalid);
      try {
        return { content: [{ type: 'text', text: await tool.run(args) }] };
      } catch (err) {
        console.error(`tool ${tool.name} failed: ${err.stack ?? err}`);
        return toolError(err.message);
      }
    },
  };
}

const isRequest = (message) => message.id !== undefined && message.method !== undefined;

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export function mcpHandler(server) {
  const methods = rpcMethods(server);
  return async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, rpcError(null, INVALID_REQUEST, 'POST only'), { Allow: 'POST' });
    const body = await readBody(req);
    if (body === null) return sendJson(res, 413, rpcError(null, INVALID_REQUEST, 'body too large'));
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      return sendJson(res, 400, rpcError(null, PARSE_ERROR, 'body must be JSON'));
    }
    if (Array.isArray(message)) return sendJson(res, 400, rpcError(null, INVALID_REQUEST, 'batches are not supported'));
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      return sendJson(res, 400, rpcError(null, INVALID_REQUEST, 'not a JSON-RPC 2.0 message'));
    }
    if (!isRequest(message)) {
      res.writeHead(202);
      return res.end();
    }
    const { id, method, params } = message;
    if (!Object.hasOwn(methods, method)) return sendJson(res, 200, rpcError(id, METHOD_NOT_FOUND, `unknown method ${method}`));
    try {
      sendJson(res, 200, { jsonrpc: '2.0', id, result: await methods[method](params) });
    } catch (err) {
      sendJson(res, 200, rpcError(id, err instanceof RpcError ? err.code : INTERNAL_ERROR, err.message));
    }
  };
}
