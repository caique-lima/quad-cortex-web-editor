import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Split big, rarely-changing code into its own cacheable chunks so an app update doesn't re-download it.
// BASE_PATH is set by the GitHub Pages workflow (a project page lives under /<repo>/); locally it stays '/'.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  server: { port: 5173 },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react';
          if (id.includes('node_modules/@bufbuild')) return 'protobuf-runtime';
          if (id.includes('packages/protocol/src/gen')) return 'protobuf-schema';
          if (id.includes('node_modules/fast-xml-parser') || id.includes('node_modules/strnum') || id.includes('node_modules/fflate')) return 'codecs';
          return undefined;
        },
      },
    },
  },
});
