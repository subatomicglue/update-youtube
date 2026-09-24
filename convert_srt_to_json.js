#!/usr/bin/env node

const { convertSrtFile } = require('./lib/subtitles');

// get srt filename from arguments
const srtFile = process.argv[2];
if (!srtFile) {
  console.error("Usage: node convert_srt_to_json.js input.srt");
  process.exit(1);
}

try {
  console.log(`Wrote ${convertSrtFile(srtFile)}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
