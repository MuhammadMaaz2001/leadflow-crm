import { createApp } from './app';
import { config } from './config';
import { ensurePlans } from './modules/subscriptions/service';

async function main() {
  await ensurePlans();
  const app = createApp();
  app.listen(config.port, () => console.log(`LeadFlow API listening on :${config.port} (${config.env}) — docs at /api/docs`));
}
main().catch((e) => { console.error(e); process.exit(1); });
