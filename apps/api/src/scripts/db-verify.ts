import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { PrismaClient } from '@leadflow/database';
import { verifyDatabaseSecurity } from '../lib/db-verify';

// Usage: DATABASE_URL=<owner connection> npm run db:verify -w @leadflow/api   (APP_DB_ROLE / PLATFORM_DB_ROLE override the default role names)
loadEnv({ path: path.resolve(__dirname, '../../../../.env') });
(async () => {
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const problems = await verifyDatabaseSecurity(prisma as never, { appRole: process.env.APP_DB_ROLE ?? 'leadflow_app', platformRole: process.env.PLATFORM_DB_ROLE ?? 'leadflow_platform' });
  const migrations = await prisma.$queryRawUnsafe<Array<{ n: bigint; failed: bigint }>>(`SELECT count(*) FILTER (WHERE finished_at IS NOT NULL) AS n, count(*) FILTER (WHERE finished_at IS NULL) AS failed FROM _prisma_migrations`);
  console.log(`migrations applied: ${migrations[0]!.n}, unfinished: ${migrations[0]!.failed}`);
  if (migrations[0]!.failed > 0n) problems.push('there are unfinished/failed migrations');
  for (const p of problems) console.error(`PROBLEM ${p}`);
  console.log(problems.length ? `\n${problems.length} problem(s) found.` : '\nDatabase security checks passed.');
  await prisma.$disconnect();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
