import swaggerUi from 'swagger-ui-express';
import { z } from 'zod';
import { routeRegistry } from './http';

function schemaOf(s: z.ZodType | undefined) {
  if (!s) return undefined;
  try {
    return z.toJSONSchema(s, { unrepresentable: 'any', io: 'input' });
  } catch {
    return { type: 'object' };
  }
}

export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routeRegistry) {
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }));
    const q = schemaOf(r.query) as { properties?: Record<string, unknown>; required?: string[] } | undefined;
    const queryParams = q?.properties ? Object.entries(q.properties).map(([name, schema]) => ({ name, in: 'query', required: q.required?.includes(name) ?? false, schema })) : [];
    const secured = r.auth !== 'public';
    paths[r.path] ??= {};
    paths[r.path]![r.method] = {
      tags: [r.tag], summary: r.summary,
      description: [r.perm ? `Requires permission: ${r.perm.join(' or ')}.` : '', r.feature ? `Requires plan feature: ${r.feature}.` : '', r.auth === 'platform' ? 'Platform administrators only.' : '', r.auth === 'org' ? 'Tenant-scoped: send the workspace in the X-Org-Id header.' : ''].filter(Boolean).join(' '),
      security: secured ? [{ sessionCookie: [] }] : [],
      parameters: [...params, ...queryParams, ...(r.auth === 'org' ? [{ name: 'X-Org-Id', in: 'header', required: true, schema: { type: 'string', format: 'uuid' } }] : [])],
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: schemaOf(r.body) } } } } : {}),
      ...(r.upload ? { requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: r.multi ? { files: { type: 'array', items: { type: 'string', format: 'binary' } } } : { file: { type: 'string', format: 'binary' } } } } } } } : {}),
      responses: { '200': { description: 'OK — { data, meta? }' }, '400': { description: 'Validation error' }, '401': { description: 'Unauthenticated' }, '403': { description: 'Forbidden / not a member / missing permission' }, '402': { description: 'Plan limit or feature restriction' } },
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: 'LeadFlow CRM API', version: '1.0.0', description: 'Multi-tenant lead management CRM. All tenant routes require a session cookie and an X-Org-Id header; the workspace is validated against the caller\'s membership on every request.' },
    servers: [{ url: '/' }],
    components: { securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'lf_session' } } },
    paths,
  };
}

export function swaggerHandlers() {
  // Swagger UI needs inline styles/scripts; relax the API's default-deny CSP for this one path only.
  const csp = (_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'");
    next();
  };
  return [csp, ...swaggerUi.serve, swaggerUi.setup(undefined, { swaggerOptions: { url: '/api/openapi.json' }, customSiteTitle: 'LeadFlow API' })];
}
