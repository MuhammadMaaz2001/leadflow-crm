/** Generates API_DOCUMENTATION.md endpoint tables and docs/openapi.json from the live route registry. */
import fs from 'node:fs';
import path from 'node:path';
import '../modules';
import { routeRegistry } from '../http';
import { openApiDocument } from '../openapi';

const root = path.resolve(__dirname, '../../../..');
const byTag = new Map<string, typeof routeRegistry>();
for (const r of routeRegistry) byTag.set(r.tag, [...(byTag.get(r.tag) ?? []), r]);

let md = `# API documentation

Base URL \`/api\` (the web app proxies it; direct API port 4000). Interactive docs: **/api/docs** (Swagger UI) · machine-readable: **/api/openapi.json** · snapshot: \`docs/openapi.json\`.

## Conventions
* **Auth** – httpOnly session cookie \`lf_session\` set by \`POST /api/auth/login\` (also accepts \`Authorization: Bearer <token>\`).
* **Workspace** – every tenant route needs \`X-Org-Id: <organization uuid>\`. The server verifies the caller's active membership; otherwise \`403 NOT_A_MEMBER\`.
* **Success** – \`{ "data": … }\`; lists add \`"meta": { page, pageSize, total, totalPages }\`. Exports return files (CSV / XLSX).
* **Errors** – \`{ "error": { "code", "message", "details?" } }\`. Validation errors: \`400 VALIDATION_ERROR\` with \`details.fields\`. Other codes: \`401 UNAUTHENTICATED\`, \`403 FORBIDDEN | MISSING_PERMISSION | NOT_A_MEMBER | MEMBER_DEACTIVATED | WORKSPACE_SUSPENDED | PLATFORM_ONLY\`, \`402 FEATURE_NOT_IN_PLAN | LEAD_LIMIT_REACHED | SEAT_LIMIT_REACHED | SUBSCRIPTION_EXPIRED\`, \`404 NOT_FOUND\` (also returned for other tenants' ids), \`409 DUPLICATE | DUPLICATE_LEAD | CONFLICT\`.
* **Pagination** – \`?page=1&pageSize=25\` (max 200). Dates are ISO-8601 UTC.
* **Rate limiting** – auth endpoints are rate-limited (disabled in tests).

## Endpoints
Legend: **perm** = any-of permission required (otherwise any workspace member); **feature** = plan feature required; \`auth\`: *public*, *user* (signed in, no workspace), *org* (workspace member), *platform* (platform administrator).

`;
for (const [tag, rows] of byTag) {
  md += `### ${tag}\n\n| Method | Path | Auth | Permission / feature | Summary |\n|---|---|---|---|---|\n`;
  for (const r of rows) md += `| ${r.method.toUpperCase()} | \`${r.path}\` | ${r.auth} | ${[r.perm?.join(' \\| '), r.feature && `feature: ${r.feature}`].filter(Boolean).join('; ') || '—'} | ${r.summary.replace(/\|/g, '/')} |\n`;
  md += '\n';
}
fs.writeFileSync(path.join(root, 'API_DOCUMENTATION.md'), md);
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/openapi.json'), JSON.stringify(openApiDocument(), null, 2));
console.log(`Documented ${routeRegistry.length} endpoints`);
