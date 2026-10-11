import { defineConfig } from 'vite'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss(), foldkit()],
  build: {
    rolldownOptions: {
      input: ['index.html', 'lab.html'],
    },
  },
  optimizeDeps: {
    entries: ['src/entry.ts'],
  },
})
