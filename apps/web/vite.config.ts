import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// During development, the website (port 5173) forwards every /api/... request to the API
// (port 3000). For the browser it is all one website, so the protected login cookie works.
export default defineConfig({
  plugins: [react()],
  // The 3D view (about 250 kB compressed) is a separate file, loaded only when opened.
  build: { chunkSizeWarningLimit: 1100 },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
