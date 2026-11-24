import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { validateProductionConfig } from '../config-validate';

// Usage: NODE_ENV=production npm run check:config -w @leadflow/api   (reads the real environment; .env only fills gaps when --dotenv is passed)
if (process.argv.includes('--dotenv')) loadEnv({ path: path.resolve(__dirname, '../../../../.env') });
const r = validateProductionConfig(process.env);
for (const w of r.warnings) console.warn(`WARN  ${w}`);
for (const e of r.errors) console.error(`ERROR ${e}`);
console.log(r.errors.length ? `\n${r.errors.length} error(s): configuration is NOT safe for production.` : '\nConfiguration passes the production checks.');
process.exit(r.errors.length ? 1 : 0);
