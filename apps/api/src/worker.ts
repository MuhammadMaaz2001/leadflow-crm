import { config } from './config';
import { validateProductionConfig } from './config-validate';
import { ensurePlans } from './modules/subscriptions/service';
import { startWorker } from './jobs';
import { log } from './lib/logger';
import { installProcessHandlers } from './lib/shutdown';

async function main() {
  if (config.isProd) {
    const r = validateProductionConfig(process.env);
    for (const w of r.warnings) log.warn(`config: ${w}`);
    if (r.errors.length) { for (const e of r.errors) log.error(`config: ${e}`); throw new Error(`Refusing to start: ${r.errors.length} production configuration error(s).`); }
  }
  installProcessHandlers();
  await ensurePlans();
  await startWorker();
}
main().catch((e) => { log.error('worker failed to start', { error: e }); process.exit(1); });
