'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveArchive } = require('./config');

function configuredGroups(config) {
  const seen = new Set();
  const groups = [];
  for (const target of config.targets || []) {
    if (!target.directory || seen.has(target.directory)) continue;
    seen.add(target.directory);
    groups.push(target.directory);
  }
  return groups;
}

function assetsInGroup(config, group) {
  const directory = resolveArchive(config, group);
  if (!fs.existsSync(directory)) return null;
  const assets = [];
  const pending = [{ directory, relative: '' }];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current.directory, { withFileTypes: true })) {
      if (entry.name === '.update-youtube') continue;
      const filename = path.join(current.directory, entry.name);
      const relative = path.join(current.relative, entry.name);
      if (entry.isDirectory()) pending.push({ directory: filename, relative });
      else if (entry.isFile() && !entry.name.startsWith('._') && entry.name.toLowerCase().endsWith('.mp4')) {
        assets.push(relative);
      }
    }
  }
  return assets.sort((left, right) => left.localeCompare(right));
}

function selectGroups(config, requested) {
  const groups = configuredGroups(config);
  if (!requested) return groups;
  if (!groups.includes(requested)) throw new Error(`Unknown group: ${requested}`);
  return [requested];
}

function printGroups(config) {
  for (const group of configuredGroups(config)) console.log(group);
}

function printAssets(config, requested) {
  const groups = selectGroups(config, requested);
  groups.forEach((group, index) => {
    if (index > 0) console.log('');
    console.log(`==================== ${group} ====================`);
    const assets = assetsInGroup(config, group);
    if (assets === null) console.log('(directory not found)');
    else if (assets.length === 0) console.log('(no MP4 assets)');
    else for (const asset of assets) console.log(asset);
  });
}

function assetDetails(probe) {
  const video = (probe.streams || []).find((stream) => stream.codec_type === 'video');
  const audio = (probe.streams || []).find((stream) => stream.codec_type === 'audio');
  if (!video) return null;
  return {
    resolution: `${Number(video.width) || 0}x${Number(video.height) || 0}`,
    videoCodec: video.codec_name || 'unknown',
    audioCodec: audio?.codec_name || 'none'
  };
}

function probeAsset(filename) {
  const result = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', filename
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) return null;
  try {
    return assetDetails(JSON.parse(result.stdout));
  } catch (error) {
    return null;
  }
}

function updateDetailWidths(widths, details) {
  widths.resolution = Math.max(widths.resolution, details.resolution.length);
  widths.videoCodec = Math.max(widths.videoCodec, details.videoCodec.length);
  widths.audioCodec = Math.max(widths.audioCodec, details.audioCodec.length);
}

function assetDetailLabel(details, widths = {}) {
  if (!details) return '[probe-error]';
  return `[${details.resolution.padEnd(widths.resolution || details.resolution.length)}:` +
    `${details.videoCodec.padEnd(widths.videoCodec || details.videoCodec.length)}:` +
    `${details.audioCodec.padEnd(widths.audioCodec || details.audioCodec.length)}]`;
}

function humanFileSize(bytes) {
  const units = ['B', 'k', 'M', 'G', 'T'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const displayed = unit === 0 ? Math.round(value) : value.toFixed(2);
  return `${displayed}${units[unit]}`;
}

function formatDetailedRow(asset, details, widths, bytes) {
  return `${assetDetailLabel(details, widths)}  ${asset}  [${humanFileSize(bytes)}]`;
}

function printDetailedAssets(config, requested) {
  const groups = selectGroups(config, requested);
  const widths = { resolution: 0, videoCodec: 0, audioCodec: 0 };
  groups.forEach((group, index) => {
    if (index > 0) console.log('');
    console.log(`==================== ${group} ====================`);
    const assets = assetsInGroup(config, group);
    if (assets === null) console.log('(directory not found)');
    else if (assets.length === 0) console.log('(no MP4 assets)');
    else {
      const directory = resolveArchive(config, group);
      for (const asset of assets) {
        const details = probeAsset(path.join(directory, asset));
        if (details) updateDetailWidths(widths, details);
        const bytes = fs.statSync(path.join(directory, asset)).size;
        console.log(formatDetailedRow(asset, details, widths, bytes));
      }
    }
  });
}

module.exports = {
  assetDetailLabel, assetDetails, assetsInGroup, configuredGroups, formatDetailedRow,
  humanFileSize, printAssets, printDetailedAssets, printGroups, selectGroups, updateDetailWidths
};
