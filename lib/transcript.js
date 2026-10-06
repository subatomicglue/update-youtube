#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ADAPTER_SOURCE = require('./transcript-adapter');
const { canonicalSrtJson, writeSrtJson } = require('./subtitles');

const PROJECT_DIRECTORY = path.resolve(__dirname, '..');
const CACHE_DIRECTORY = path.join(PROJECT_DIRECTORY, '.generate-transcript');
const DEFAULT_BACKEND = 'faster-whisper';
const MEDIA_EXTENSIONS = new Set(['.mp4', '.mp3', '.m4a', '.ogg', '.mov']);

class NoTranscriptTextError extends Error {
  constructor() {
    super('The backend returned no transcript text.');
    this.name = 'NoTranscriptTextError';
    this.code = 'NO_TRANSCRIPT_TEXT';
  }
}

const BACKENDS = Object.freeze({
  'faster-whisper': {
    description: 'Whisper large-v3; native timestamps, forced English by default (default backend)',
    dependency: 'faster-whisper==1.2.1',
    model: 'Systran/faster-whisper-large-v3',
    source: 'PyPI package from SYSTRAN/faster-whisper; model from Hugging Face Systran',
    nativeTimestamps: true
  },
  'qwen3-asr': {
    description: 'Qwen3-ASR 1.7B; strong general ASR, with conservative chunk timestamps for Greek',
    dependency: 'qwen-asr==0.0.6',
    model: 'Qwen/Qwen3-ASR-1.7B',
    source: 'PyPI package and Hugging Face model from the official Qwen project',
    nativeTimestamps: false
  },
  'omnilingual-asr': {
    description: 'Meta Omnilingual ASR; supports explicit Ancient Greek (grc), with chunk timestamps',
    dependency: 'omnilingual-asr==0.2.0',
    model: 'omniASR_LLM_1B_v2',
    source: 'PyPI package and model assets from Meta facebookresearch/omnilingual-asr',
    nativeTimestamps: false
  }
});

function printHelp(cacheDirectory = CACHE_DIRECTORY, commandName = 'generate-transcript.js') {
  console.log(`Usage: ${commandName} [options] FILE_OR_DIRECTORY

Generate an SRT transcript beside one media file, or beside every supported
media file directly within a directory. Inputs are never modified. Existing
SRT output is refused unless --force is supplied.

Options:
  --backend NAME       Transcription backend (default: ${DEFAULT_BACKEND})
  --model NAME         Override the backend's default model
  --language LANGUAGE  en, auto, el, or grc (default: en)
  --chunk-seconds N    Chunk size for backends without native timestamps (default: 20)
  --force              Safely replace an existing SRT after generation succeeds
  --simulate           Show setup and output paths without installing or transcribing
  --help, -h           Show this help

Backends:
${Object.entries(BACKENDS).map(([name, backend]) => `  ${name.padEnd(18)} ${backend.description}\n${''.padEnd(20)}package: ${backend.dependency}\n${''.padEnd(20)}model: ${backend.model}\n${''.padEnd(20)}source: ${backend.source}`).join('\n')}

Dependencies and model weights are downloaded only when first needed and are
kept under:
  ${cacheDirectory}

Trust policy:
  Python is never downloaded; an installed Python 3.10-3.12 is required.
  Pinned packages come only from official PyPI. Default models come only from
  the upstream publishers named above. --model is an explicit unverified
  override and prints a warning.

Notes:
  faster-whisper uses native timestamps and defaults to forced English so music
  does not bias language detection and occasional Greek remains in an English/
  Latin-script transcript. Qwen3-ASR and Omnilingual ASR use short chunks as
  conservative SRT time boundaries because their Greek paths do not provide a
  suitable native forced aligner. Use --language grc to test Omnilingual ASR's
  explicit Ancient Greek model conditioning.

Examples:
  ${commandName} lesson.mp4
  ${commandName} ./lessons
  ${commandName} --backend qwen3-asr lesson.mp4
  ${commandName} --backend omnilingual-asr --language grc lesson.mp4
  ${commandName} --backend faster-whisper --force lesson.mp4`);
}

function positiveNumber(value, option) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${option} requires a positive number.`);
  return number;
}

function optionValue(argv, index, option) {
  if (index + 1 >= argv.length) throw new Error(`${option} requires a value.`);
  return argv[index + 1];
}

function parseArguments(argv) {
  const options = {
    backend: DEFAULT_BACKEND, model: null, language: 'en', chunkSeconds: 20,
    force: false, simulate: false, help: false, video: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--force') options.force = true;
    else if (argument === '--simulate') options.simulate = true;
    else if (argument === '--backend') options.backend = optionValue(argv, index++, '--backend');
    else if (argument.startsWith('--backend=')) options.backend = argument.slice('--backend='.length);
    else if (argument === '--model') options.model = optionValue(argv, index++, '--model');
    else if (argument.startsWith('--model=')) options.model = argument.slice('--model='.length);
    else if (argument === '--language') options.language = optionValue(argv, index++, '--language');
    else if (argument.startsWith('--language=')) options.language = argument.slice('--language='.length);
    else if (argument === '--chunk-seconds') options.chunkSeconds = positiveNumber(optionValue(argv, index++, '--chunk-seconds'), '--chunk-seconds');
    else if (argument.startsWith('--chunk-seconds=')) options.chunkSeconds = positiveNumber(argument.slice('--chunk-seconds='.length), '--chunk-seconds');
    else if (argument === '--') {
      const remaining = argv.slice(index + 1);
      if (remaining.length !== 1 || options.video) throw new Error('Exactly one media file or directory is required.');
      [options.video] = remaining;
      break;
    } else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
    else if (options.video) throw new Error('Exactly one media file or directory is required.');
    else options.video = argument;
  }
  if (!Object.prototype.hasOwnProperty.call(BACKENDS, options.backend)) {
    throw new Error(`Unknown backend: ${options.backend}. Choose: ${Object.keys(BACKENDS).join(', ')}.`);
  }
  if (!['auto', 'en', 'el', 'grc'].includes(options.language)) {
    throw new Error('--language must be auto, en, el, or grc.');
  }
  if (!options.help && !options.video) throw new Error('Exactly one media file or directory is required.');
  return options;
}

function mediaInputs(input) {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) throw new Error(`Input not found: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    if (!MEDIA_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      throw new Error(`Unsupported media file: ${resolved}`);
    }
    return [resolved];
  }
  if (!stat.isDirectory()) throw new Error(`Input is not a media file or directory: ${resolved}`);
  const files = fs.readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(resolved, entry.name))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) throw new Error(`No supported media files found in: ${resolved}`);
  return files;
}

function run(command, args, options = {}) {
  if (options.show !== false) console.log(`> ${[command, ...args].map(shellQuote).join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture && result.stderr ? `: ${result.stderr.trim()}` : '';
    throw new Error(`${path.basename(command)} exited with status ${result.status}${detail}`);
  }
  return result;
}

function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=+-]+$/u.test(text) ? text : JSON.stringify(text);
}

function pythonCommand() {
  const candidates = ['python3.12', 'python3'];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-c', 'import sys; print((3, 10) <= sys.version_info[:2] <= (3, 12))'], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim() === 'True') {
      const executable = spawnSync(candidate, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
      if (executable.status === 0) return executable.stdout.trim();
    }
  }
  throw new Error('Python 3.10-3.12 is required; Python 3.12 is recommended.');
}

function backendEnvironment(cacheDirectory) {
  const models = path.join(cacheDirectory, 'models');
  return {
    ...process.env,
    HF_HOME: path.join(models, 'huggingface'),
    HUGGINGFACE_HUB_CACHE: path.join(models, 'huggingface', 'hub'),
    TORCH_HOME: path.join(models, 'torch'),
    FAIRSEQ2_CACHE_DIR: path.join(models, 'fairseq2'),
    XDG_CACHE_HOME: path.join(models, 'xdg'),
    PIP_CACHE_DIR: path.join(cacheDirectory, 'pip-cache'),
    PIP_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
    PIP_INDEX_URL: 'https://pypi.org/simple',
    PIP_EXTRA_INDEX_URL: '',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_INPUT: '1',
    PYTHONUNBUFFERED: '1'
  };
}

function venvPython(venv) {
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
}

function ensureBackend(name, cacheDirectory, simulate) {
  const backend = BACKENDS[name];
  const venv = path.join(cacheDirectory, 'environments', name);
  const python = venvPython(venv);
  const marker = path.join(venv, '.dependency');
  const installed = fs.existsSync(python) && fs.existsSync(marker)
    && fs.readFileSync(marker, 'utf8').trim() === backend.dependency;
  if (installed) return python;
  console.log(`[setup] ${simulate ? 'would install' : 'install'} ${name}: ${backend.dependency}`);
  if (simulate) return python;
  fs.mkdirSync(path.dirname(venv), { recursive: true });
  if (!fs.existsSync(python)) {
    const bootstrap = pythonCommand();
    console.log(`[setup] Python bootstrap: ${bootstrap}`);
    run(bootstrap, ['-m', 'venv', venv]);
  }
  const environment = backendEnvironment(cacheDirectory);
  run(python, ['-m', 'pip', 'install', '--index-url', 'https://pypi.org/simple', backend.dependency], { env: environment });
  const inventory = run(python, ['-m', 'pip', 'freeze', '--all'], {
    env: environment, capture: true, show: false
  });
  fs.writeFileSync(path.join(venv, 'installed.txt'), inventory.stdout);
  fs.writeFileSync(marker, `${backend.dependency}\n`);
  return python;
}

function mediaDuration(filename, ffprobe = 'ffprobe') {
  const result = run(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filename
  ], { capture: true, show: false });
  return Number(result.stdout.trim());
}

function assertAudioStream(filename, ffprobe = 'ffprobe') {
  const result = run(ffprobe, [
    '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index',
    '-of', 'csv=p=0', filename
  ], { capture: true, show: false });
  if (!result.stdout.trim()) {
    throw new Error(`Media has no audio stream and cannot be transcribed: ${filename}`);
  }
}

function createChunks(video, workDirectory, seconds, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe') {
  const pattern = path.join(workDirectory, 'chunk-%06d.wav');
  run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '16000',
    '-f', 'segment', '-segment_time', String(seconds), '-reset_timestamps', '1', pattern
  ]);
  const chunks = fs.readdirSync(workDirectory).filter((name) => /^chunk-\d+\.wav$/u.test(name)).sort();
  let start = 0;
  return chunks.map((name) => {
    const filename = path.join(workDirectory, name);
    const duration = mediaDuration(filename, ffprobe);
    const chunk = { filename, start, end: start + duration };
    start = chunk.end;
    return chunk;
  });
}

function formatTimestamp(seconds) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function srtText(segments) {
  const usable = segments.filter((segment) => segment.text && segment.text.trim());
  if (usable.length === 0) throw new NoTranscriptTextError();
  return `${usable.map((segment, index) => `${index + 1}\n${formatTimestamp(segment.start)} --> ${formatTimestamp(segment.end)}\n${segment.text.trim()}\n`).join('\n')}\n`;
}

function installOutput(output, content, force) {
  const temporary = `${output}.${process.pid}.tmp`;
  const backup = `${output}.${process.pid}.backup`;
  fs.writeFileSync(temporary, content, { flag: 'wx' });
  let backedUp = false;
  try {
    if (fs.existsSync(output)) {
      if (!force) throw new Error(`Output already exists: ${output}. Use --force to replace it.`);
      fs.renameSync(output, backup);
      backedUp = true;
    }
    fs.renameSync(temporary, output);
    if (backedUp) fs.unlinkSync(backup);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    if (backedUp && !fs.existsSync(output) && fs.existsSync(backup)) fs.renameSync(backup, output);
    throw error;
  }
}

function transcriptOutput(video, backend) {
  const resolved = path.resolve(video);
  const stem = path.basename(resolved, path.extname(resolved));
  return path.join(path.dirname(resolved), `${stem}.${backend}.srt`);
}

function materializeAdapter(cacheDirectory) {
  const runtimeDirectory = path.join(cacheDirectory, 'runtime');
  const filename = path.join(runtimeDirectory, 'transcribe-backend.py');
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  if (!fs.existsSync(filename) || fs.readFileSync(filename, 'utf8') !== ADAPTER_SOURCE) {
    const temporary = `${filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, ADAPTER_SOURCE);
    fs.renameSync(temporary, filename);
  }
  return filename;
}

function generate(options) {
  const backend = BACKENDS[options.backend];
  const video = path.resolve(options.video);
  if (!fs.existsSync(video) || !fs.statSync(video).isFile()) throw new Error(`Video not found: ${video}`);
  const stem = path.basename(video, path.extname(video));
  const output = transcriptOutput(video, options.backend);
  if (fs.existsSync(output) && !options.force) throw new Error(`Output already exists: ${output}. Use --force to replace it.`);
  assertAudioStream(video, options.ffprobe);
  const model = options.model || backend.model;
  if (options.model && options.model !== backend.model) {
    console.warn(`[WARNING] custom model override is not covered by the verified default source policy: ${options.model}`);
  }
  console.log(`[transcript] backend: ${options.backend}`);
  console.log(`[transcript] model: ${model}`);
  console.log(`[transcript] input: ${video}`);
  console.log(`[transcript] output: ${output}`);
  const cacheDirectory = options.cacheDirectory || CACHE_DIRECTORY;
  const python = ensureBackend(options.backend, cacheDirectory, options.simulate);
  if (options.simulate) return output;

  const workRoot = path.join(cacheDirectory, 'work');
  fs.mkdirSync(workRoot, { recursive: true });
  const workDirectory = fs.mkdtempSync(path.join(workRoot, `${options.backend}-${process.pid}-`));
  try {
    const resultFile = path.join(workDirectory, 'result.json');
    const manifestFile = path.join(workDirectory, 'manifest.json');
    const manifest = backend.nativeTimestamps
      ? [{ filename: video, start: 0, end: mediaDuration(video, options.ffprobe) }]
      : createChunks(video, workDirectory, options.chunkSeconds, options.ffmpeg, options.ffprobe);
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    run(python, [
      materializeAdapter(cacheDirectory),
      '--backend', options.backend, '--model', model, '--language', options.language,
      '--manifest', manifestFile, '--result', resultFile,
      '--model-cache', path.join(cacheDirectory, 'models')
    ], { env: backendEnvironment(cacheDirectory) });
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    if (!Array.isArray(result.segments)) throw new Error('Backend result did not contain a segment list.');
    installOutput(output, srtText(result.segments), options.force);
    const canonicalJson = canonicalSrtJson(video, output);
    writeSrtJson(output, canonicalJson);
    console.log(`[transcript] created ${output}`);
    console.log(`[transcript] canonical JSON ${canonicalJson}`);
    return output;
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  }
}

function main(argv, defaults = {}) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      printHelp(defaults.cacheDirectory || CACHE_DIRECTORY, defaults.commandName || 'generate-transcript.js');
      return 0;
    }
    let failures = 0;
    const directoryInput = fs.statSync(path.resolve(options.video)).isDirectory();
    const inputs = mediaInputs(options.video);
    if (inputs.length > 1) console.log(`[transcript] ${inputs.length} media files found`);
    for (const video of inputs) {
      try {
        const output = transcriptOutput(video, options.backend);
        if (directoryInput && fs.existsSync(output) && !options.force) {
          console.log(`[transcript] skip existing ${output}`);
          continue;
        }
        generate({ ...defaults, ...options, video });
      } catch (error) {
        failures += 1;
        console.error(`[ERROR] ${video}: ${error.message}`);
      }
    }
    return failures > 0 ? 1 : 0;
  } catch (error) {
    console.error(`[ERROR] ${error.message}`);
    return 1;
  }
}

module.exports = {
  assertAudioStream, BACKENDS, CACHE_DIRECTORY, DEFAULT_BACKEND, formatTimestamp, generate,
  installOutput, main, materializeAdapter, mediaInputs, parseArguments, printHelp, srtText,
  NoTranscriptTextError, transcriptOutput
};
