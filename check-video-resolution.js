#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');

function printHelp() {
  console.log(`Usage: check-video-resolution.js [options] VIDEO...

Print video filenames that do not meet the requested minimum resolution.

Options:
  --width N     Minimum video width in pixels
  --height N    Minimum video height in pixels
  --help, -h    Show this help

At least one of --width or --height is required.

Examples:
  check-video-resolution.js --height 1080 *.mp4
  check-video-resolution.js --width 1920 --height 1080 video1.mp4 video2.mp4`);
}

function positiveInteger(value, option) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${option} requires a positive integer.`);
  return number;
}

function parseArguments(argv) {
  const options = { width: null, height: null, files: [], help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--width') options.width = positiveInteger(argv[++index], '--width');
    else if (argument === '--height') options.height = positiveInteger(argv[++index], '--height');
    else if (argument === '--') options.files.push(...argv.slice(index + 1));
    else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
    else options.files.push(argument);
    if (argument === '--') break;
  }
  if (!options.help && options.width === null && options.height === null) {
    throw new Error('At least one of --width or --height is required.');
  }
  if (!options.help && options.files.length === 0) throw new Error('At least one video file is required.');
  return options;
}

function resolutionChecks(options) {
  return [
    { enabled: options.width !== null, passes: (video) => video.width >= options.width },
    { enabled: options.height !== null, passes: (video) => video.height >= options.height }
  ].filter((check) => check.enabled);
}

function meetsRequirements(video, options) {
  return resolutionChecks(options).every((check) => check.passes(video));
}

function probeVideo(filename) {
  const result = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'json', filename
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `ffprobe exited with status ${result.status}`);
  const stream = JSON.parse(result.stdout).streams?.[0];
  if (!stream || !Number.isInteger(stream.width) || !Number.isInteger(stream.height)) {
    throw new Error('No video resolution found.');
  }
  return stream;
}

function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  let errors = 0;
  for (const filename of options.files) {
    try {
      if (!meetsRequirements(probeVideo(filename), options)) console.log(filename);
    } catch (error) {
      errors += 1;
      console.error(`[ERROR] ${filename}: ${error.message}`);
    }
  }
  return errors > 0 ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { meetsRequirements, parseArguments, resolutionChecks };
