'use strict';

const fs = require('fs');
const path = require('path');

const TRANSCRIPT_SUFFIX = '.srt.json';
const YOUTUBE_ID = /-([A-Za-z0-9_-]{11})(?:\.[^.]+)?\.srt\.json$/u;

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    return null;
  }
}

function filenameDetails(filename) {
  const name = path.basename(filename);
  const match = name.match(YOUTUBE_ID);
  const youtubeID = match ? match[1] : '';
  const fallbackStem = match
    ? name.slice(0, match.index)
    : name.slice(0, -TRANSCRIPT_SUFFIX.length).replace(/\.[^.]+$/u, '');
  return {
    fallbackStem,
    title: fallbackStem.replace(/_/gu, ' ').replace(/\s+/gu, ' ').trim(),
    youtubeID
  };
}

function findMetadata(transcriptFile, details) {
  const directory = path.dirname(transcriptFile);
  const expected = path.join(directory, `${details.fallbackStem}.info.json`);
  const direct = readJson(expected);
  if (direct) return direct;
  if (!details.youtubeID) return null;
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith('.info.json') || name.startsWith('._')) continue;
    const metadata = readJson(path.join(directory, name));
    if (metadata && metadata.id === details.youtubeID) return metadata;
  }
  return null;
}

function transcriptText(items) {
  if (!Array.isArray(items)) throw new Error('Transcript JSON must contain an array.');
  return items.map((item) => (item && typeof item.text === 'string' ? item.text.trim() : ''))
    .filter(Boolean).join(' ')
    .replace(/\s+([,.;:!?])/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

function generateTranscriptMarkdown(transcriptFile, templateFile) {
  const absoluteTranscript = path.resolve(transcriptFile);
  if (!absoluteTranscript.endsWith(TRANSCRIPT_SUFFIX)) {
    throw new Error(`Expected a ${TRANSCRIPT_SUFFIX} file: ${transcriptFile}`);
  }
  const items = readJson(absoluteTranscript);
  if (!items) throw new Error(`Unable to read transcript JSON: ${absoluteTranscript}`);
  const details = filenameDetails(absoluteTranscript);
  const metadata = findMetadata(absoluteTranscript, details);
  const values = {
    title: (metadata && (metadata.title || metadata.fulltitle)) || details.title || 'Untitled',
    youtubeID: (metadata && metadata.id) || details.youtubeID,
    transcript: transcriptText(items)
  };
  const template = fs.readFileSync(templateFile, 'utf8');
  const markdown = template.replace(/\{%([A-Za-z]+)%\}/gu, (token, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : token);
  const output = absoluteTranscript.slice(0, -TRANSCRIPT_SUFFIX.length) + '.md';
  fs.writeFileSync(output, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
  return output;
}

module.exports = { filenameDetails, findMetadata, generateTranscriptMarkdown, transcriptText };
