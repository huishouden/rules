import { defineConfig } from 'vitest/config';

// Every test file shares one Firestore emulator and clears it before each test, so files run one
// after another.
export default defineConfig({ test: { fileParallelism: false } });
