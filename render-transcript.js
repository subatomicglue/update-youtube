#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { generateTranscriptMarkdown } = require('./lib/transcript-markdown');

function templatePath() {
  const directories = [
    process.cwd(),
    __dirname,
    path.dirname(process.execPath)
  ];
  const found = directories.map((directory) => path.join(directory, 'template-transcript.md'))
    .find((filename) => fs.existsSync(filename));
  if (!found) throw new Error('Unable to find template-transcript.md.');
  return found;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    console.error('Usage: render-transcript.js FILE.srt.json');
    return 1;
  }
  try {
    console.log(`Wrote ${generateTranscriptMarkdown(argv[0], templatePath())}`);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, templatePath };
