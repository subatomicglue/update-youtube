'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('./process');

function scpTranscripts(directory, destination, options = {}) {
  if (!destination) throw new Error('An SCP destination is required.');
  if (!fs.existsSync(directory)) {
    console.log(`[scp] transcript directory does not exist: ${directory}`);
    return;
  }
  const files = fs.readdirSync(directory)
    .map((name) => path.join(directory, name))
    .filter((filename) => fs.statSync(filename).isFile());
  if (files.length === 0) {
    console.log('[scp] no transcript files to upload.');
    return;
  }
  run('scp', ['-C', ...files, destination], options);
}

module.exports = { scpTranscripts };
