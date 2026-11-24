import { z } from 'zod';

// In browsers a strict Content-Security-Policy forbids `eval`/`new Function` (no 'unsafe-eval'), and Zod's JIT compiler
// probes for it. Run Zod in its interpreted mode there; servers keep the JIT. Must execute before any schema is created.
if (typeof (globalThis as { window?: unknown }).window !== 'undefined') z.config({ jitless: true });
