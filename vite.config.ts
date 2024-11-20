import { defineConfig } from 'vite'
import path from 'path'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [
    dts()
  ],
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      name: 'AsyncTaskSchedule',
      fileName: (format) => `index.${format}.js`,
      formats: ['es', 'umd']
    },
    rollupOptions: {
      // ...existing code or additional settings...
    }
  },
  // Add Vitest configuration here
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      reporter: ['text', 'lcov']
    }
    // ...additional Vitest settings if needed...
  },
  // ...existing code or additional settings...
})