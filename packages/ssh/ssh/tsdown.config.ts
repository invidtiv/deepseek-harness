import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'lib/types/index.js',
    protocol: 'lib/types/protocol.js',
    schemas: 'lib/types/schemas.js',
    worlds: 'lib/types/worlds.js',
    broker: 'lib/types/broker.js',
    'local-world': 'lib/types/local-world.js',
    helper: 'lib/types/helper-entry.js',
  },
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false,
})
