import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: process.env.NODE_ENV === 'production' ? '/dashboard/' : '/dashboard-dev/',
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    watch: {
      usePolling: true
    },
    allowedHosts: [
      
      'localhost',
      ''
    ]
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true
  }
});
