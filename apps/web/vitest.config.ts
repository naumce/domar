import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // `xlsx` has no exports map: Node would load its CJS build, whose exports are attached by a
  // function call, so `import { read, utils }` would be undefined under jsdom. Inlining makes Vite
  // resolve the `module` field (xlsx.mjs) here exactly as it does in the browser build.
  test: { environment: 'jsdom', globals: false, setupFiles: ['./test/setup.ts'], server: { deps: { inline: ['xlsx'] } } },
});
