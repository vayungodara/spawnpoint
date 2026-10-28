import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, gzipSync, constants } from 'node:zlib'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

// Write .br and .gz next to every text asset; the panel serves them to
// browsers that accept them (fastify-static preCompressed).
function precompress(): Plugin {
  let outDir = 'dist'
  return {
    name: 'precompress',
    apply: 'build',
    configResolved: (c) => { outDir = c.build.outDir },
    closeBundle() {
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
      for (const file of walk(outDir).filter((f) => /\.(js|css|html|svg|json)$/.test(f))) {
        const buf = readFileSync(file)
        if (buf.length < 1024) continue
        writeFileSync(`${file}.br`, brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }))
        writeFileSync(`${file}.gz`, gzipSync(buf, { level: 9 }))
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), precompress()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    proxy: {
      '/api': 'http://localhost:25570',
    },
  },
})
