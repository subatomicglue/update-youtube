'use strict';

const fs = require('fs');

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
  const subtitles = convertSrtText(fs.readFileSync(srtFile, 'utf8'));
  fs.writeFileSync(jsonFile, `${JSON.stringify(subtitles, null, 2)}\n`);
  return jsonFile;
}

module.exports = { convertSrtFile, convertSrtText };
