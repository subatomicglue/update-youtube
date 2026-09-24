#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectDirectory = path.resolve(__dirname, '..');
const distDirectory = path.join(projectDirectory, 'dist');
const bundle = path.join(distDirectory, 'update-youtube.cjs');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectDirectory,
    stdio: 'inherit',
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

fs.rmSync(distDirectory, { recursive: true, force: true });
fs.mkdirSync(distDirectory, { recursive: true });

run(require.resolve('esbuild/bin/esbuild'), [
  'update-youtube.js', '--bundle', '--platform=node', '--format=cjs',
  `--outfile=${bundle}`
]);

run(process.execPath, [
  require.resolve('@yao-pkg/pkg/lib-es5/bin.js'),
  bundle, '--sea',
  '--targets', 'node22-macos-x64,node22-macos-arm64,node22-win-x64,node22-linux-x64,node22-linux-arm64',
  '--out-path', distDirectory
]);

fs.unlinkSync(bundle);
for (const filename of ['example.config.json', 'example.customconfig.json', 'README.md']) {
  fs.copyFileSync(path.join(projectDirectory, filename), path.join(distDirectory, filename));
}

console.log('\nDistribution is ready in dist/:');
for (const filename of fs.readdirSync(distDirectory).sort()) console.log(`  ${filename}`);
