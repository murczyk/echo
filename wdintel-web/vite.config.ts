import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      react: resolve(__dirname, 'node_modules/react'),
      'react-dom': resolve(__dirname, 'node_modules/react-dom'),
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['react', 'react-dom', '@mui/material', '@mui/icons-material'],
  },
});
