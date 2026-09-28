'use strict';

const fs = require('fs');
const path = require('path');
const { youtubeIdFromFilename } = require('./archive');
const { resolveArchive } = require('./config');
const { selectGroups } = require('./list-assets');
const { isSrtCompanion, isSrtJsonCompanion } = require('./subtitles');

function topLevelFiles(directory) {
  if (!fs.existsSync(directory)) return null;
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('._'))
    .map((entry) => entry.name);
}

function archiveIds(directory, target) {
  const filename = path.join(directory, target.archive || 'archive.txt');
  if (!fs.existsSync(filename)) return [];
  return fs.readFileSync(filename, 'utf8').split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u).pop())
    .filter((id, index, all) => id && all.indexOf(id) === index);
}

function readMetadata(filename) {
  try {
    const metadata = JSON.parse(fs.readFileSync(filename, 'utf8'));
    return metadata && typeof metadata === 'object' ? metadata : null;
  } catch (error) {
    return null;
  }
}

function metadataId(metadata) {
  return metadata && metadata.id ? String(metadata.id) : null;
}

function subtitleForId(files, id) {
  return files.find((name) => name.includes(id) && name.endsWith('.srt')) || null;
}

function subtitleForStem(files, stem) {
  return files.find((name) => isSrtCompanion(name, stem)) || null;
}

function jsonForVideo(files, stem, id, subtitle) {
  return files.find((name) => name === `${subtitle}.json`
    || isSrtJsonCompanion(name, stem) || (id && name.includes(id))) || null;
}

function videoIdFromSubtitle(name) {
  const match = name && name.match(/-([A-Za-z0-9_-]{11})\.[^.]+\.srt$/u);
  return match ? match[1] : null;
}

function displayAsset(asset) {
  return asset.endsWith('.mp4') ? JSON.stringify(asset.slice(0, -4)) : asset;
}

function validateGroup(config, group) {
  const directory = resolveArchive(config, group);
  const files = topLevelFiles(directory);
  if (files === null) return null;

  const target = (config.targets || []).find((candidate) => candidate.directory === group) || {};
  const fileSet = new Set(files);
  const mp4s = files.filter((name) => name.toLowerCase().endsWith('.mp4'));
  const metadataFiles = files.filter((name) => name.endsWith('.info.json'));
  const subtitles = files.filter((name) => name.endsWith('.srt'));
  const transcriptJson = files.filter((name) => name.endsWith('.srt.json'));
  const records = new Map();
  const metadataIds = new Set();

  for (const mp4 of mp4s) {
    const stem = mp4.slice(0, -4);
    const metadataName = `${stem}.info.json`;
    const missing = [];
    let id = youtubeIdFromFilename(mp4);
    if (id) metadataIds.add(id);
    if (!fileSet.has(metadataName)) {
      missing.push('.info.json');
    } else {
      id = metadataId(readMetadata(path.join(directory, metadataName)));
      if (!id) missing.push('.info.json');
      else metadataIds.add(id);
    }

    const subtitle = (id && subtitleForId(subtitles, id)) || subtitleForStem(subtitles, stem);
    if (!id && subtitle) {
      id = videoIdFromSubtitle(subtitle);
      if (id) metadataIds.add(id);
    }
    if (!subtitle) missing.unshift('.srt');
    else if (!jsonForVideo(transcriptJson, stem, id, subtitle)) missing.push('.srt.json');
    if (missing.length > 0) records.set(mp4, missing);
  }

  for (const metadataName of metadataFiles) {
    const metadata = readMetadata(path.join(directory, metadataName));
    if (metadata && metadata._type === 'playlist') continue;
    const stem = metadataName.slice(0, -10);
    const mp4 = `${stem}.mp4`;
    if (fileSet.has(mp4)) continue;
    const missing = ['.mp4'];
    const id = metadataId(metadata);
    if (!id) missing.push('.info.json');
    else metadataIds.add(id);
    const subtitle = (id && subtitleForId(subtitles, id)) || subtitleForStem(subtitles, stem);
    if (!subtitle) missing.push('.srt');
    else if (!jsonForVideo(transcriptJson, stem, id, subtitle)) missing.push('.srt.json');
    records.set(mp4, missing);
  }

  for (const id of archiveIds(directory, target)) {
    if (!metadataIds.has(id)) records.set(`archive ID ${id}`, ['.mp4', '.info.json', '.srt']);
  }

  return [...records.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function printValidation(config, requested) {
  const groups = selectGroups(config, requested);
  let missing = 0;
  groups.forEach((group, index) => {
    if (index > 0) console.log('');
    console.log(`==================== ${group} ====================`);
    const records = validateGroup(config, group);
    if (records === null) console.log('(directory not found)');
    else if (records.length === 0) console.log('(complete)');
    else {
      missing += records.length;
      for (const [asset, assets] of records) console.log(`[missing] for ${displayAsset(asset)}: [${assets.join(', ')}]`);
    }
  });
  return missing;
}

module.exports = { archiveIds, displayAsset, printValidation, validateGroup };
