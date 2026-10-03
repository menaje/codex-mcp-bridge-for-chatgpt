import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('dist/server', { recursive: true });
copyFileSync('worker.mjs', 'dist/server/index.js');
