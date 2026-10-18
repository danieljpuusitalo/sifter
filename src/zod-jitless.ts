import { z } from 'zod';

// zod compiles object parsers with `new Function` when it thinks that is allowed.
// An extension page has no 'unsafe-eval', so the probe is a blocked eval and a CSP
// violation report on every load, and hard rule 2 says no eval anyway. Import this
// first, before any schema is built.
z.config({ jitless: true });
