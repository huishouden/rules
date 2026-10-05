import { defineConfig } from 'vitest/config';

// Every test file shares one Firestore emulator and clears it before each test, so files run one
// after another. The kit ships its build for bundlers (imports without `.js`), so Vite transforms
// it rather than Node loading it (test/kit-fields.test.ts imports its field lists).
export default defineConfig({ test: { fileParallelism: false, server: { deps: { inline: [/@huishouden\/pwa-kit/] } } } });
