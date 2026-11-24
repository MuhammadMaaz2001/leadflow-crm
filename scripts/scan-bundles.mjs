// Fails when anything that looks like a secret ends up in the browser bundles (apps/web/.next/static).
// Usage: npm run build && npm run scan:secrets      (reads values from the environment and from .env, which holds the dev secrets)
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const staticDir = path.join(root, 'apps/web/.next/static');
if (!fs.existsSync(staticDir)) { console.error('apps/web/.next/static not found: run `npm run build` first.'); process.exit(2); }

const SECRET_NAME = /(PASSWORD|SECRET|TOKEN|API_KEY|ACCESS_KEY|DATABASE_URL|REDIS_URL|SMTP|DSN|PRIVATE)/i;
const values = new Map();
const add = (k, v) => { if (v && v.length >= 6 && SECRET_NAME.test(k) && !/^(true|false|development|production|test)$/i.test(v)) values.set(v, k); };
for (const [k, v] of Object.entries(process.env)) add(k, v);
for (const f of ['.env', '.env.local', '.env.production']) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line); if (m) add(m[1], m[2].replace(/^['"]|['"]$/g, '')); }
}
// well-known dev credentials of this repository and generic credential shapes
const PATTERNS = [
  [/postgres(ql)?:\/\/[^\s"'`]+:[^\s"'`@]+@/i, 'database URL with credentials'], [/redis:\/\/[^\s"'`]*:[^\s"'`@]+@/i, 'redis URL with credentials'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key id'], [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'], [/sk_(live|test)_[0-9a-zA-Z]{16,}/, 'payment secret key'],
  [/Admin#Pass2026|Demo#Pass2026/, 'seed account password'], [/leadflow_(app|platform)?_?dev/, 'development database password'],
];

let files = 0; const hits = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.(js|css|html|json|map|txt)$/.test(e.name)) continue;
    files++;
    const text = fs.readFileSync(p, 'utf8');
    for (const [v, k] of values) if (text.includes(v)) hits.push(`${path.relative(root, p)}: contains the value of ${k}`);
    for (const [re, label] of PATTERNS) if (re.test(text)) hits.push(`${path.relative(root, p)}: ${label}`);
  }
})(staticDir);
console.log(`scanned ${files} client bundle files against ${values.size} secret values and ${PATTERNS.length} patterns`);
if (hits.length) { for (const h of hits) console.error(`LEAK ${h}`); process.exit(1); }
console.log('no secrets found in browser bundles');
