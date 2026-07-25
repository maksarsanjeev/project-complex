import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@complex/protocol': fileURLToPath(
        new URL('../../packages/protocol/src/index.ts', import.meta.url),
      ),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5273,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    // three + drei объективно тяжёлые; предупреждение о размере тут только шумит.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        // Тяжёлые движки рендера — отдельными чанками: они меняются редко
        // и кэшируются между релизами приложения.
        manualChunks: (id: string) => {
          if (id.includes('node_modules/three')) return 'three'
          if (id.includes('@react-three')) return 'r3f'
          if (id.includes('@xyflow')) return 'flow'
          return undefined
        },
      },
    },
  },
})
