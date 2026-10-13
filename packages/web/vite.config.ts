import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  optimizeDeps: { include: ['sql.js'] },
  server: { port: 3001 },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
