import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest only auto-cleans when `globals` is on, and it is not — the same
// setup the console UI package needs, for the same reason. Without this one
// test's DOM survives into the next and every query finds two of everything.
afterEach(cleanup);
