import { PrismaClient } from '../generated/client';

// Applies runtime role passwords from the environment. Passwords never live in migration SQL.
async function main() {
  const prisma = new PrismaClient();
  const app = process.env.APP_DB_PASSWORD;
  const platform = process.env.PLATFORM_DB_PASSWORD;
  if (!app || !platform) throw new Error('APP_DB_PASSWORD and PLATFORM_DB_PASSWORD must be set');
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  await prisma.$executeRawUnsafe(`ALTER ROLE leadflow_app PASSWORD ${q(app)}`);
  await prisma.$executeRawUnsafe(`ALTER ROLE leadflow_platform PASSWORD ${q(platform)}`);
  await prisma.$disconnect();
  console.log('Runtime role passwords applied.');
}
main().catch((e) => { console.error(e); process.exit(1); });
