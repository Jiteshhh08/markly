import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Same-origin dev: '/api/*' AND '/assets/*' are proxied to the local API
    // so the session cookie stays first-party (localhost page ↔ localhost
    // cookie) instead of third-party (localhost page ↔ 127.0.0.1 API), which
    // browsers may refuse to store/send. /assets carries the tenant artwork
    // (header/watermark) the preview document references. Requires
    // VITE_API_URL empty (see .env.example). Production mirrors both paths
    // with rewrites (vercel.json / nginx).
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      '/assets': { target: 'http://127.0.0.1:4000', changeOrigin: true },
    },
  },
})
