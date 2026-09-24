#!/usr/bin/env node
'use strict';

const requiredMajor = 22;
const currentMajor = Number(process.versions.node.split('.')[0]);

if (currentMajor < requiredMajor) {
  console.error([
    '',
    `[build] Node.js ${requiredMajor} or newer is required to build standalone executables.`,
    `[build] Current version: ${process.version}`,
    '[build] Install/select Node.js 22+, then run: npm install && npm run build',
    ''
  ].join('\n'));
  process.exit(1);
}
