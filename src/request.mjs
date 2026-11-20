import { readBody } from './http-io.mjs';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function decodePath(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'malformed percent-escape in path');
  }
}

// A field type checks one value. `parse(value, { source, catalog })` returns the typed value, or undefined when the
// value is not valid, which answers 400 with "<field> must <must>". Path and query values are strings, body values JSON.
export const type = (must, parse) => ({ must, parse });

// An optional field that is absent, or an empty query value, takes `fallback`. Other fields are required.
export const optional = (t, fallback) => ({ ...t, optional: true, fallback });

export const nullable = (t) => type(`${t.must} or null`, (v, ctx) => (v === null ? null : t.parse(v, ctx)));

export const matching = (re, noun) => type(`be ${noun}`, (v) => (typeof v === 'string' && re.test(v) ? v : undefined));

// A query switch: `1` turns it on.
export const flag = type('be 1 or absent', (v) => (v === '1' ? true : undefined));

export const bool = type('be true or false', (v) => (typeof v === 'boolean' ? v : undefined));

// A string that names something `has(value, ctx)` finds. In the path, a value that names nothing answers 404
// "no <noun> <value>" instead of 400.
export const known = (noun, has) => ({ ...type(`be an existing ${noun} id`, (v, ctx) => (typeof v === 'string' && has(v, ctx) ? v : undefined)), noun });

// An array of `t` values with each value once. `plural` names the values in the message.
export const arrayOf = (t, plural, { nonEmpty = false } = {}) =>
  type(`be ${nonEmpty ? 'a non-empty' : 'an'} array of ${plural}`, (v, ctx) => {
    if (!Array.isArray(v) || (nonEmpty && !v.length)) return undefined;
    const values = v.map((item) => t.parse(item, ctx));
    return values.includes(undefined) ? undefined : [...new Set(values)];
  });

export const int = (min, max = Infinity) =>
  type(max === Infinity ? `be a whole number, ${min} or more` : `be ${min} to ${max}`, (v, { source }) => {
    const n = source === 'body' ? v : /^\d+$/.test(v) ? Number(v) : NaN;
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
  });

export const oneOf = (values) =>
  type(`be ${values.length > 1 ? `${values.slice(0, -1).join(', ')} or ${values.at(-1)}` : values[0]}`, (v) => (values.includes(v) ? v : undefined));

// '/api/topics/:id' -> /^\/api\/topics\/(?<id>[^/]+)$/
export const pathPattern = (path) => new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);

async function readObject(req, { optional }) {
  const text = await readBody(req);
  if (text === null) throw new HttpError(413, 'body too large');
  if (optional && !text.trim()) return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object');
  return body;
}

function field(t, key, value, ctx) {
  if (value === undefined && t.optional) return t.fallback;
  const parsed = value === undefined ? undefined : t.parse(value, ctx);
  if (parsed === undefined && t.noun && ctx.source === 'path') throw new HttpError(404, `no ${t.noun} ${value}`);
  if (parsed === undefined) throw new HttpError(400, `${key} must ${t.must}`);
  return parsed;
}

// The path, query and body of a request to `route`, checked against its `params`, `query` and `body`, as one object.
// A query key or body field the route does not declare is refused. A body whose fields are all optional must hold one,
// unless the route sets `optionalBody`, which also lets the body be empty. `catalog()` is read at most once.
export async function parseRequest(route, { match, req, url, catalog }) {
  let cat;
  const ctx = { catalog: () => (cat ??= catalog()) };
  const args = {};
  for (const [key, t] of Object.entries(route.params ?? {})) args[key] = field(t, key, decodePath(match.groups[key]), { ...ctx, source: 'path' });
  const query = route.query ?? {};
  const unknownKey = [...url.searchParams.keys()].find((key) => !Object.hasOwn(query, key));
  if (unknownKey) throw new HttpError(400, `unknown parameter ${unknownKey}`);
  for (const [key, t] of Object.entries(query)) args[key] = field(t, key, url.searchParams.get(key) || undefined, { ...ctx, source: 'query' });
  if (route.body) {
    const body = await readObject(req, { optional: route.optionalBody });
    const keys = Object.keys(route.body);
    const unknownField = Object.keys(body).find((key) => !keys.includes(key));
    if (unknownField) throw new HttpError(400, `unknown field ${unknownField}`);
    if (!route.optionalBody && !Object.keys(body).length && keys.every((key) => route.body[key].optional)) {
      throw new HttpError(400, `send at least one of ${keys.join(', ')}`);
    }
    for (const [key, t] of Object.entries(route.body)) args[key] = field(t, key, body[key], { ...ctx, source: 'body' });
  }
  return args;
}
