import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist');
await cp('public', 'dist', { recursive: true });
await build({
  entryPoints: ['public/app.js'],
  outfile: 'dist/app.js',
  bundle: true,
  format: 'esm',
  minify: true,
  sourcemap: false,
  target: 'es2022',
});
console.log('Store frontend built.');
