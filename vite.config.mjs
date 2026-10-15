import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  base: './',
  server: {
    // 5374 is reserved by Windows on some installations (EACCES on ::1/127.0.0.1).
    port: 15374
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), 'index.html'),
        audit: resolve(process.cwd(), 'audit.html'),
        bookDetail: resolve(process.cwd(), 'book-detail.html')
      }
    }
  }
})
