'use strict';

const fs = require('fs');
const path = require('path');

function convertSrtText(data) {
  const blocks = data.replace(/\r\n/g, '\n').split(/\n{2,}/)
    .map((block) => block.trim()).filter(Boolean);
  const subtitles = [];
  let prevText = '';
  let prevItem = null;
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim());
    if (lines.length < 2) continue;
    const timeIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeIndex < 0) continue;
    const [start, end] = lines[timeIndex].split('-->').map((value) => value.trim());
    let text = lines.slice(timeIndex + 1).join(' ').replace(/\s+/g, ' ').trim();
    if (prevText && text.startsWith(prevText)) text = text.slice(prevText.length).trim();
    if (!text) continue;
    if (prevItem && text === prevItem.text) {
      prevItem.end = end;
    } else {
      prevItem = { start, end, text };
      subtitles.push(prevItem);
    }
    prevText = text;
  }
  return subtitles;
}

function convertSrtFile(srtFile) {
  const jsonFile = `${srtFile}.json`;
  if (fs.existsSync(jsonFile)) return jsonFile;
  return writeSrtJson(srtFile, jsonFile);
}

function writeSrtJson(srtFile, jsonFile) {
  const subtitles = convertSrtText(fs.readFileSync(srtFile, 'utf8'));
  const content = `${JSON.stringify(subtitles, null, 2)}\n`;
  if (fs.existsSync(jsonFile) && fs.readFileSync(jsonFile, 'utf8') === content) return jsonFile;
  const temporary = `${jsonFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, jsonFile);
  return jsonFile;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// Recognize every supported companion form without treating a different title
// that merely begins with the same text as belonging to this video.
function isSrtCompanion(name, stem) {
  if (!name || name.startsWith('._') || !name.endsWith('.srt')) return false;
  if (name === `${stem}.srt` || name.startsWith(`${stem}.`)) return true;
  return new RegExp(`^${escapeRegExp(stem)}-[A-Za-z0-9_-]{11}\\.[^.]+\\.srt$`, 'u').test(name);
}

function isSrtJsonCompanion(name, stem) {
  return Boolean(name && !name.startsWith('._') && name.endsWith('.srt.json')
    && isSrtCompanion(name.slice(0, -5), stem));
}

function canonicalSrtJson(video, selectedSrt, id = null) {
  const directory = path.dirname(video);
  const stem = path.basename(video, path.extname(video));
  const existing = fs.readdirSync(directory)
    .filter((name) => !name.startsWith('._') && name.endsWith('.srt.json'))
    .map((name) => path.join(directory, name));
  const exact = `${selectedSrt}.json`;
  if (existing.includes(exact)) return exact;
  const associated = existing.find((filename) => {
    const name = path.basename(filename);
    return isSrtJsonCompanion(name, stem) || (id && name.includes(id));
  });
  return associated || exact;
}

module.exports = {
  canonicalSrtJson, convertSrtFile, convertSrtText,
  isSrtCompanion, isSrtJsonCompanion, writeSrtJson
};
