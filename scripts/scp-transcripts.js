#!/usr/bin/env node
'use strict';

const path = require('path');
const { scpTranscripts } = require('../lib/scp-transcripts');

const [directory = 'Transcripts-YouTube', destination] = process.argv.slice(2);
try {
  scpTranscripts(path.resolve(directory), destination);
} catch (error) {
  console.error(`[ERROR] ${error.message}`);
  process.exit(1);
}
