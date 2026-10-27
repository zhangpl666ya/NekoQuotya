import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// Three builds (out/):
//   main      the app (src/main) and the collector utility process (src/collector/host.ts), ES modules
//   preload   one script per window, CommonJS because sandboxed preloads cannot be ES modules
//   renderer  the pet window and the launcher panel; TSX is compiled by esbuild (no React
//             fast refresh plugin, so pages need no inline scripts and the CSP stays strict)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          collector: resolve('src/collector/host.ts'),
        },
      },
    },
  },
  preload: {
    // Sandboxed preloads cannot load other files, so each must be one standalone bundle.
    // The two preloads therefore share no runtime module (channel names live in
    // src/shared/ipc/pet.ts and ipc/launcher.ts); otherwise Rollup would split it into a chunk.
    build: {
      rollupOptions: {
        input: {
          pet: resolve('src/preload/pet.ts'),
          launcher: resolve('src/preload/launcher.ts'),
          sessions: resolve('src/preload/sessions.ts'),
          settings: resolve('src/preload/settings.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    esbuild: { jsx: 'automatic' },
    build: {
      rollupOptions: {
        input: {
          pet: resolve('src/renderer/pet/index.html'),
          launcher: resolve('src/renderer/launcher/index.html'),
          sessions: resolve('src/renderer/sessions/index.html'),
          settings: resolve('src/renderer/settings/index.html'),
        },
      },
    },
  },
});
