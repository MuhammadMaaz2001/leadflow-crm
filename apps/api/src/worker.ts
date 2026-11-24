import { ensurePlans } from './modules/subscriptions/service';
import { startWorker } from './jobs';

ensurePlans().then(startWorker).catch((e) => { console.error(e); process.exit(1); });
