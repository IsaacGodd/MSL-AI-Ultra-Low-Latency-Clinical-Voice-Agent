// One-time build: bundles @vapi-ai/web into a browser-ready IIFE
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

await esbuild.build({
  stdin: {
    contents: `import Vapi from '@vapi-ai/web'; window.Vapi = Vapi;`,
    resolveDir: '.',
  },
  bundle: true,
  format: 'iife',
  outfile: 'public/vapi.bundle.js',
  platform: 'browser',
  minify: false,
});

console.log('✅  public/vapi.bundle.js built');
