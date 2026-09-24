#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DURATION_TOLERANCE_SECONDS = 1;

function usage() {
  console.log(`Usage: compare.js [checks] <required directory> <larger directory>

Verify that every top-level MP4 in the required directory appears in the larger
directory. Extra MP4 files in the larger directory are ignored. Matching files
display resolution/video codec/audio codec/runtime for both copies. A missing
file displays "missing" in the second stats column and is marked [ERROR].

Checks:
  --res       Compare video resolution
  --time      Compare runtime (tolerance: ${DURATION_TOLERANCE_SECONDS} second)
  --vid       Compare video codec
  --aud       Compare audio codec

If no check switches are supplied, all four checks are enabled.

Other:
  --help, -h  Show this help

Examples:
  ./compare.js required-archive larger-archive
  ./compare.js --res --time required-archive larger-archive`);
}

function parseArguments(argv) {
  const checks = { res: false, time: false, vid: false, aud: false };
  const directories = [];
  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--res') checks.res = true;
    else if (argument === '--time') checks.time = true;
    else if (argument === '--vid') checks.vid = true;
    else if (argument === '--aud') checks.aud = true;
    else if (argument.startsWith('-')) throw new Error(`unknown option: ${argument}`);
    else directories.push(argument);
  }
  if (!Object.values(checks).some(Boolean)) {
    for (const key of Object.keys(checks)) checks[key] = true;
  }
  return { checks, directories };
}

function mp4Names(directory) {
  return new Set(fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.mp4'))
    .map((entry) => entry.name));
}

function probe(filename) {
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height',
    '-of', 'json',
    filename
  ], { encoding: 'utf8', shell: false });

  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) throw new Error((result.stderr || 'ffprobe failed').trim());

  const data = JSON.parse(result.stdout);
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video' && stream.codec_name);
  const audio = streams.find((stream) => stream.codec_type === 'audio' && stream.codec_name);
  const duration = Number(data.format && data.format.duration);

  if (!video) throw new Error('no valid video stream');
  if (!audio) throw new Error('no valid audio stream');
  if (!Number.isInteger(video.width) || !Number.isInteger(video.height)) throw new Error('invalid video resolution');
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('invalid duration');

  return {
    resolution: `${video.width}x${video.height}`,
    video: video.codec_name,
    audio: audio.codec_name,
    duration
  };
}

function formatDuration(seconds) {
  const rounded = Math.round(seconds * 1000) / 1000;
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = (rounded % 60).toFixed(3).padStart(6, '0');
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${remainder}`;
}

function formatStats(stats, resolutionWidth, videoWidth, audioWidth) {
  if (!stats) return 'unreadable';
  return `${stats.resolution.padEnd(resolutionWidth)}/${stats.video.padEnd(videoWidth)}/${stats.audio.padEnd(audioWidth)}/${formatDuration(stats.duration)}`;
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    usage();
    return 2;
  }
  if (options.help) {
    usage();
    return 0;
  }
  if (options.directories.length !== 2) {
    usage();
    return 2;
  }

  const [firstArgument, secondArgument] = options.directories;

  const firstDirectory = path.resolve(firstArgument);
  const secondDirectory = path.resolve(secondArgument);
  for (const directory of [firstDirectory, secondDirectory]) {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      console.error(`ERROR: not a directory: ${directory}`);
      return 2;
    }
  }

  const firstNames = mp4Names(firstDirectory);
  const secondNames = mp4Names(secondDirectory);
  const requiredNames = [...firstNames].sort((left, right) => left.localeCompare(right));

  const rows = [];
  for (const name of requiredNames) {
    let first;
    let second;
    let failure = '';
    const secondMissing = !secondNames.has(name);
    try {
      first = probe(path.join(firstDirectory, name));
    } catch (error) {
      failure = `first: ${error.message}`;
    }
    if (secondMissing) {
      failure += `${failure ? '; ' : ''}missing from second directory`;
    } else {
      try {
        second = probe(path.join(secondDirectory, name));
      } catch (error) {
        failure += `${failure ? '; ' : ''}second: ${error.message}`;
      }
    }

    if (first && second) {
      const differences = [];
      if (options.checks.res && first.resolution !== second.resolution) differences.push('resolution');
      if (options.checks.vid && first.video !== second.video) differences.push('video codec');
      if (options.checks.aud && first.audio !== second.audio) differences.push('audio codec');
      if (options.checks.time && Math.abs(first.duration - second.duration) > DURATION_TOLERANCE_SECONDS) {
        differences.push(`runtime > ${DURATION_TOLERANCE_SECONDS}s tolerance`);
      }
      failure = differences.join(', ');
    }

    rows.push({
      name,
      first,
      second,
      secondMissing,
      failure
    });
  }

  const validStats = rows.flatMap((row) => [row.first, row.second]).filter(Boolean);
  const resolutionWidth = Math.max(0, ...validStats.map((stats) => stats.resolution.length));
  const videoWidth = Math.max(0, ...validStats.map((stats) => stats.video.length));
  const audioWidth = Math.max(0, ...validStats.map((stats) => stats.audio.length));
  for (const row of rows) {
    row.firstText = formatStats(row.first, resolutionWidth, videoWidth, audioWidth);
    row.secondText = row.secondMissing
      ? 'missing'
      : formatStats(row.second, resolutionWidth, videoWidth, audioWidth);
  }
  const firstWidth = Math.max(0, ...rows.map((row) => row.firstText.length));
  const secondWidth = Math.max(0, ...rows.map((row) => row.secondText.length));
  for (const row of rows) {
    const status = row.failure ? '[ERROR]' : '[OK]   ';
    console.log(`${status} ${row.firstText.padEnd(firstWidth)} | ${row.secondText.padEnd(secondWidth)} | ${row.name}`);
  }

  return rows.some((row) => row.failure) ? 1 : 0;
}

process.exitCode = main();
