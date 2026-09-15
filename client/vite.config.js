import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// envDir points at the project root so the single .env is shared.
// Only VITE_* variables are exposed to the browser; the Places key stays server-side.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  envDir: '..',
  worker: { format: 'es' },
  build: {
    rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom', 'react-dom/client'] } } },
  },
  server: {
    port: 5174,
    proxy: { '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true }, '/oauth/google-categories': { target: 'http://127.0.0.1:4000', changeOrigin: true } },
  },
});
