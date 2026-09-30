'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { findConfigPath, mergeConfig, resolveArchive } = require('../lib/config');
const { backfillInfo, outputFormat, repairArchivedVideos, videoFormat, _test: archiveTest } = require('../lib/archive');
const {
  canonicalSrtJson, convertSrtText, isSrtCompanion, isSrtJsonCompanion
} = require('../lib/subtitles');
const { handleMigrations } = require('../lib/migrate');
const { colorErrorLines, errorText, formatProcessError, ProcessError, run } = require('../lib/process');
const { meetsRequirements, parseArguments: parseVideoCheckArguments } = require('../check-video-resolution');
const { focusConfig, parseArguments: parseArchiveArguments } = require('../update-youtube');
const { backupDirectory, compareQuality, selectedStreams, _test: qualityTest } = require('../lib/quality');
const {
  assetDetailLabel, assetDetails, assetsInGroup, configuredGroups,
  formatDetailedRow, humanFileSize, selectGroups, updateDetailWidths
} = require('../lib/list-assets');
const { displayAsset, validateGroup } = require('../lib/validate');
const { generateTranscriptMarkdown } = require('../lib/transcript-markdown');
const {
  assertAudioStream, BACKENDS: transcriptBackends, DEFAULT_BACKEND: defaultTranscriptBackend,
  installOutput: installTranscriptOutput, parseArguments: parseTranscriptArguments,
  main: transcriptMain, materializeAdapter, mediaInputs: transcriptMediaInputs, srtText,
  transcriptOutput
} = require('../generate-transcript');

let failures = 0;
function test(name, callback) {
  try {
    callback();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}\n${error.stack}`);
  }
}

test('custom targets and post-steps append while settings override', () => {
  const result = mergeConfig(
    { applicationDirectory: '.update-youtube', targets: [{ url: 'a' }], postSteps: [], cookies: { macos: 'safari', windows: 'edge' } },
    { applicationDirectory: '/cache', targets: [{ url: 'b' }], postSteps: [{ command: 'x' }], cookies: { windows: 'chrome' } }
  );
  assert.strictEqual(result.applicationDirectory, '/cache');
  assert.deepStrictEqual(result.targets.map((item) => item.url), ['a', 'b']);
  assert.strictEqual(result.postSteps.length, 1);
  assert.deepStrictEqual(result.cookies, { macos: 'safari', windows: 'chrome' });
});

test('transcript Markdown uses filename metadata when info JSON is missing', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'transcript-markdown-'));
  try {
    const transcript = path.join(temporary, 'Fallback_Title-BQ2SAA08k7k.en.srt.json');
    const template = path.join(temporary, 'template-transcript.md');
    fs.writeFileSync(transcript, JSON.stringify([{ text: 'First line.' }, { text: 'Second line.' }]));
    fs.writeFileSync(template, '# {%title%}\n{%youtubeID%}\n{%transcript%}\n');
    const output = generateTranscriptMarkdown(transcript, template);
    assert.strictEqual(output, path.join(temporary, 'Fallback_Title-BQ2SAA08k7k.en.md'));
    assert.strictEqual(fs.readFileSync(output, 'utf8'),
      '# Fallback Title\nBQ2SAA08k7k\nFirst line. Second line.\n');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('simulation reports missing transcript Markdown without writing it', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'transcript-markdown-plan-'));
  const id = 'BQ2SAA08k7k';
  try {
    fs.writeFileSync(path.join(temporary, 'archive.txt'), `youtube ${id}\n`);
    fs.writeFileSync(path.join(temporary, 'Lesson.mp4'), 'video');
    fs.writeFileSync(path.join(temporary, 'Lesson.info.json'), JSON.stringify({ id, title: 'Lesson' }));
    fs.writeFileSync(path.join(temporary, `Lesson-${id}.en.srt`), '1\n00:00:00,000 --> 00:00:01,000\nText\n');
    fs.writeFileSync(path.join(temporary, `Lesson-${id}.en.srt.json`), JSON.stringify([{ text: 'Text' }]));
    const messages = [];
    const originalLog = console.log;
    console.log = (message) => messages.push(String(message));
    try {
      archiveTest.fetchSubtitles({
        configDirectory: path.resolve(__dirname, '..'), cookies: {}
      }, {}, temporary, { directory: 'Lesson', archive: 'archive.txt' }, { simulate: true });
    } finally {
      console.log = originalLog;
    }
    assert(messages.some((message) => message === `[transcript] markdown Lesson-${id}.en.md`));
    assert(!fs.existsSync(path.join(temporary, `Lesson-${id}.en.md`)));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('archive paths resolve beneath archiveDirectory', () => {
  const config = { configDirectory: '/config', workingDirectory: '/work', archiveDirectory: 'archive' };
  assert.strictEqual(resolveArchive(config), path.resolve('/work/archive'));
  assert.strictEqual(resolveArchive(config, 'ExampleChannel/LiveStreams'), path.resolve('/work/archive/ExampleChannel/LiveStreams'));
  assert.strictEqual(resolveArchive(config, '/absolute/videos'), path.resolve('/absolute/videos'));
});

test('config lookup falls back from current directory to script directory', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'video-archiver-config-'));
  try {
    const current = path.join(temporary, 'current');
    const script = path.join(temporary, 'script');
    fs.mkdirSync(current);
    fs.mkdirSync(script);
    fs.writeFileSync(path.join(script, 'config.json'), '{}');
    assert.strictEqual(findConfigPath(null, [current, script]), path.join(script, 'config.json'));
    fs.writeFileSync(path.join(current, 'config.json'), '{}');
    assert.strictEqual(findConfigPath(null, [current, script]), path.join(current, 'config.json'));
    assert.strictEqual(findConfigPath(path.join(script, 'explicit.json'), [current, script]), path.join(script, 'explicit.json'));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('subtitle detection only accepts companions beside the active MP4', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'video-archiver-subtitles-'));
  try {
    const legacy = path.join(temporary, '720p');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'Old-title-video123.en.srt'), 'legacy');
    fs.writeFileSync(path.join(temporary, '._Current_title-video123.en.srt'), 'AppleDouble');
    const predicate = (name) => name.includes('video123') && name.endsWith('.srt');
    assert.strictEqual(archiveTest.findMatchingFile(temporary, predicate), null);

    const active = path.join(temporary, 'Current_title-video123.en.srt');
    fs.writeFileSync(active, 'current');
    assert.strictEqual(archiveTest.findMatchingFile(temporary, predicate), active);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('subtitle detection accepts a language suffix without a YouTube ID', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'video-archiver-language-subtitle-'));
  try {
    const video = path.join(temporary, 'Recruitment.mp4');
    const subtitle = path.join(temporary, 'Recruitment.en.srt');
    fs.writeFileSync(video, 'video');
    fs.writeFileSync(subtitle, 'subtitle');
    assert.strictEqual(archiveTest.subtitleForVideo(video), subtitle);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('subtitle companion matching covers languages and backends without prefix collisions', () => {
  const stem = 'Lesson';
  for (const name of [
    'Lesson.srt', 'Lesson.en.srt', 'Lesson.en-orig.srt', 'Lesson.en-US.srt',
    'Lesson.en-GB.srt', 'Lesson.faster-whisper.srt', 'Lesson.qwen3-asr.srt',
    'Lesson.omnilingual-asr.srt', 'Lesson-BQ2SAA08k7k.en-AU.srt'
  ]) assert.strictEqual(isSrtCompanion(name, stem), true, name);
  for (const name of [
    '._Lesson.en.srt', 'Lesson-Part.en.srt', 'Lesson-BQ2SAA08k7.en.srt',
    'Other.en.srt', 'Lesson.en.vtt'
  ]) assert.strictEqual(isSrtCompanion(name, stem), false, name);
  assert.strictEqual(isSrtJsonCompanion('Lesson.en-orig.srt.json', stem), true);
  assert.strictEqual(isSrtJsonCompanion('Lesson.qwen3-asr.srt.json', stem), true);
  assert.strictEqual(isSrtJsonCompanion('._Lesson.en.srt.json', stem), false);
});

test('canonical transcript JSON ignores AppleDouble metadata', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'transcript-appledouble-'));
  try {
    const video = path.join(temporary, 'Lesson.mp4');
    const subtitle = path.join(temporary, 'Lesson.en.srt');
    fs.writeFileSync(video, 'video');
    fs.writeFileSync(subtitle, 'subtitle');
    fs.writeFileSync(path.join(temporary, '._Lesson.en.srt.json'), 'AppleDouble');
    assert.strictEqual(canonicalSrtJson(video, subtitle), `${subtitle}.json`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('subtitle rate limits are recognized for fallback selection', () => {
  assert.strictEqual(archiveTest.isRateLimitError({ stderr: "HTTP Error 429: Too Many Requests" }), true);
  assert.strictEqual(archiveTest.isRateLimitError({ stderr: 'Video unavailable' }), false);
});

test('subtitle downloads use the token-free embedded client with browser impersonation', () => {
  const key = process.platform === 'darwin' ? 'macos' : (process.platform === 'win32' ? 'windows' : 'linux');
  assert.deepStrictEqual(archiveTest.subtitleClientArgs({ cookies: { [key]: 'safari' } }), [
    '--extractor-args', 'youtube:player_client=web_embedded', '--impersonate', 'safari'
  ]);
});

test('English subtitle fallbacks prefer manual, standard, original, and regional tracks', () => {
  const attempts = archiveTest.subtitleAttempts({ subtitleLanguage: 'en' }, {}, {
    subtitles: { en: [], 'en-US': [], 'en-GB': [], 'en-CA': [], mystery: [] },
    automatic_captions: { en: [], 'en-orig': [], 'en-US': [], 'en-GB': [], 'en-AU': [], 'xx-orig': [], translated: [] }
  });
  assert.deepStrictEqual(attempts.map(({ language, automatic }) => [language, automatic]), [
    ['en', false], ['en', true], ['en-orig', true],
    ['en-US', false], ['en-US', true], ['en-GB', false], ['en-GB', true],
    ['en-CA', false], ['en-AU', true]
  ]);
  assert.strictEqual(archiveTest.isTranscriptJsonName('Title-video123.en.srt.json'), true);
  assert.strictEqual(archiveTest.isTranscriptJsonName('Title-video123.en-orig.srt.json'), true);
  assert.strictEqual(archiveTest.isTranscriptJsonName('Title-video123.en-US.srt.json'), true);
  assert.strictEqual(archiveTest.isTranscriptJsonName('Title.srt.json'), true);
  assert.strictEqual(archiveTest.isTranscriptJsonName('._Title-video123.en.srt.json'), false);
});

test('manually authored YouTube subtitles are distinguished from automatic tracks', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'transcript-priority-'));
  try {
    const video = path.join(temporary, 'Lesson.mp4');
    const youtube = path.join(temporary, 'Lesson-video123.en.srt');
    const generated = path.join(temporary, 'Lesson.faster-whisper.srt');
    fs.writeFileSync(video, 'video');
    fs.writeFileSync(youtube, 'youtube');
    fs.writeFileSync(generated, 'generated');
    const manual = { subtitles: { en: [] }, automatic_captions: { en: [] } };
    const automatic = { subtitles: {}, automatic_captions: { en: [] } };
    assert.strictEqual(archiveTest.isManualYoutubeSubtitle(youtube, manual), true);
    assert.strictEqual(archiveTest.selectedTranscriptSource(video, youtube, manual), youtube);
    assert.strictEqual(archiveTest.isManualYoutubeSubtitle(youtube, automatic), false);
    assert.strictEqual(archiveTest.selectedTranscriptSource(video, youtube, automatic), generated);
    assert.strictEqual(archiveTest.isManualYoutubeSubtitle(generated, manual), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('transcript adapter is materialized from embedded source', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'transcript-adapter-'));
  try {
    const adapter = materializeAdapter(temporary);
    assert.strictEqual(fs.existsSync(adapter), true);
    assert.match(fs.readFileSync(adapter, 'utf8'), /from faster_whisper import WhisperModel/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('local transcript fallback defaults to only faster-whisper', () => {
  assert.deepStrictEqual(archiveTest.transcriptGenerationSettings({}, {}), {
    enabled: true, backend: 'faster-whisper', language: 'en', chunkSeconds: 20
  });
  assert.strictEqual(
    archiveTest.transcriptGenerationSettings({ transcriptGeneration: { enabled: false } }, {}).enabled,
    false
  );
});

test('missing YouTube subtitles fall back to the shared local transcript generator', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'local-transcript-fallback-'));
  try {
    fs.writeFileSync(path.join(temporary, 'archive.txt'), 'youtube BQ2SAA08k7k\n');
    fs.writeFileSync(path.join(temporary, 'Lesson.mp4'), 'video');
    fs.writeFileSync(path.join(temporary, 'Lesson.info.json'), JSON.stringify({
      id: 'BQ2SAA08k7k', subtitles: {}, automatic_captions: {}
    }));
    let invocation = null;
    const errors = archiveTest.fetchSubtitles({ configDirectory: temporary, cookies: {} }, {}, temporary, {
      directory: 'videos', archive: 'archive.txt'
    }, {
      simulate: false,
      generateTranscript(options) {
        invocation = options;
        const output = path.join(temporary, 'Lesson.srt');
        fs.writeFileSync(output, '1\n00:00:00,000 --> 00:00:01,000\nHello\n');
        return output;
      }
    });
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(invocation.backend, 'faster-whisper');
    assert.strictEqual(invocation.video, path.join(temporary, 'Lesson.mp4'));
    assert.strictEqual(fs.existsSync(path.join(temporary, 'Lesson.srt.json')), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('normal archive runs reuse an existing generated transcript without invoking its backend', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'local-transcript-existing-'));
  try {
    fs.writeFileSync(path.join(temporary, 'archive.txt'), 'youtube BQ2SAA08k7k\n');
    fs.writeFileSync(path.join(temporary, 'Lesson.mp4'), 'video');
    fs.writeFileSync(path.join(temporary, 'Lesson.info.json'), JSON.stringify({
      id: 'BQ2SAA08k7k', subtitles: {}, automatic_captions: {}
    }));
    fs.writeFileSync(path.join(temporary, 'Lesson.faster-whisper.srt'),
      '1\n00:00:00,000 --> 00:00:01,000\nGenerated transcript\n');
    let invocations = 0;
    const errors = archiveTest.fetchSubtitles({ configDirectory: temporary, cookies: {} }, {}, temporary, {
      directory: 'videos', archive: 'archive.txt'
    }, {
      simulate: false,
      generateTranscript() {
        invocations += 1;
        throw new Error('generator must not run');
      }
    });
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(invocations, 0);
    assert.strictEqual(fs.existsSync(path.join(temporary, 'Lesson.faster-whisper.srt.json')), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('normal runs never regenerate an existing transcript JSON', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'transcript-source-revert-'));
  try {
    const video = path.join(temporary, 'Lesson.mp4');
    const generated = path.join(temporary, 'Lesson.faster-whisper.srt');
    fs.writeFileSync(path.join(temporary, 'archive.txt'), 'youtube BQ2SAA08k7k\n');
    fs.writeFileSync(video, 'video');
    fs.writeFileSync(path.join(temporary, 'Lesson.info.json'), JSON.stringify({ id: 'BQ2SAA08k7k' }));
    fs.writeFileSync(path.join(temporary, 'Lesson-BQ2SAA08k7k.en.srt'),
      '1\n00:00:00,000 --> 00:00:01,000\nYouTube source\n');
    fs.writeFileSync(generated, '1\n00:00:00,000 --> 00:00:01,000\nGenerated source\n');
    const config = { configDirectory: temporary, cookies: {} };
    const target = { directory: 'videos', archive: 'archive.txt' };
    archiveTest.fetchSubtitles(config, {}, temporary, target, { simulate: false });
    const canonical = path.join(temporary, 'Lesson.faster-whisper.srt.json');
    assert.match(fs.readFileSync(canonical, 'utf8'), /Generated source/u);
    fs.unlinkSync(generated);
    archiveTest.fetchSubtitles(config, {}, temporary, target, { simulate: false });
    assert.match(fs.readFileSync(canonical, 'utf8'), /Generated source/u);
    fs.unlinkSync(canonical);
    archiveTest.fetchSubtitles(config, {}, temporary, target, { simulate: false });
    assert.match(fs.readFileSync(path.join(temporary, 'Lesson-BQ2SAA08k7k.en.srt.json'), 'utf8'), /YouTube source/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('captured tool output supports metadata larger than the Node default buffer', () => {
  const result = run(process.execPath, ['-e', "process.stdout.write('x'.repeat(2 * 1024 * 1024))"], {
    capture: true,
    quiet: true
  });
  assert.strictEqual(result.stdout.length, 2 * 1024 * 1024);
});

test('video resolution checks support independent minimum dimensions', () => {
  assert.deepStrictEqual(
    parseVideoCheckArguments(['--width', '1920', '--height', '1080', 'one.mp4']).files,
    ['one.mp4']
  );
  assert(meetsRequirements({ width: 1920, height: 1080 }, { width: 1920, height: 1080 }));
  assert(!meetsRequirements({ width: 1280, height: 1080 }, { width: 1920, height: 1080 }));
  assert(meetsRequirements({ width: 640, height: 1080 }, { width: null, height: 1080 }));
});

test('transcript generation exposes all backends and safe defaults', () => {
  assert.deepStrictEqual(Object.keys(transcriptBackends), [
    'faster-whisper', 'qwen3-asr', 'omnilingual-asr'
  ]);
  assert.strictEqual(defaultTranscriptBackend, 'faster-whisper');
  assert.strictEqual(transcriptBackends['faster-whisper'].model, 'Systran/faster-whisper-large-v3');
  assert.deepStrictEqual(parseTranscriptArguments(['lesson.mp4']), {
    backend: 'faster-whisper', model: null, language: 'en', chunkSeconds: 20,
    force: false, simulate: false, help: false, video: 'lesson.mp4'
  });
  assert.strictEqual(
    parseTranscriptArguments(['--backend', 'omnilingual-asr', '--language', 'grc', 'lesson.mp4']).language,
    'grc'
  );
  assert.throws(() => parseTranscriptArguments(['--backend', 'unknown', 'lesson.mp4']), /Unknown backend/u);
  assert.strictEqual(path.basename(transcriptOutput('lesson.mp4', 'faster-whisper')), 'lesson.faster-whisper.srt');
  assert.strictEqual(path.basename(transcriptOutput('lesson.mp4', 'qwen3-asr')), 'lesson.qwen3-asr.srt');
  assert.strictEqual(path.basename(transcriptOutput('lesson.mp4', 'omnilingual-asr')), 'lesson.omnilingual-asr.srt');
});

test('transcript generation reuses the one existing YouTube JSON', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'transcript-json-reuse-'));
  try {
    const video = path.join(temporary, 'Lesson.mp4');
    const generated = path.join(temporary, 'Lesson.faster-whisper.srt');
    const youtubeJson = path.join(temporary, 'Lesson-BQ2SAA08k7k.en.srt.json');
    fs.writeFileSync(video, 'video');
    fs.writeFileSync(generated, 'generated');
    fs.writeFileSync(path.join(temporary, 'Lesson-BQ2SAA08k7k.en.srt'), 'youtube');
    fs.writeFileSync(youtubeJson, '[]');
    assert.strictEqual(canonicalSrtJson(video, generated, 'BQ2SAA08k7k'), youtubeJson);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('transcript generation formats SRT and protects existing output', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'generate-transcript-test-'));
  try {
    const output = path.join(temporary, 'lesson.srt');
    const first = srtText([{ start: 1.25, end: 3.5, text: 'Hello' }]);
    assert.match(first, /00:00:01,250 --> 00:00:03,500/u);
    installTranscriptOutput(output, first, false);
    assert.throws(() => installTranscriptOutput(output, 'replacement', false), /already exists/u);
    assert.strictEqual(fs.readFileSync(output, 'utf8'), first);
    installTranscriptOutput(output, 'replacement', true);
    assert.strictEqual(fs.readFileSync(output, 'utf8'), 'replacement');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('transcript generation rejects video-only media before invoking a backend', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'transcript-no-audio-'));
  try {
    const fakeProbe = path.join(temporary, 'ffprobe');
    fs.writeFileSync(fakeProbe, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakeProbe, 0o755);
    assert.throws(() => assertAudioStream('/video-only.mp4', fakeProbe), /no audio stream/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('transcript directory input finds supported top-level media files', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'generate-transcript-inputs-'));
  try {
    fs.writeFileSync(path.join(temporary, 'B.MP3'), 'audio');
    fs.writeFileSync(path.join(temporary, 'a.mp4'), 'video');
    fs.writeFileSync(path.join(temporary, 'c.m4a'), 'audio');
    fs.writeFileSync(path.join(temporary, 'ignore.txt'), 'text');
    fs.mkdirSync(path.join(temporary, 'nested'));
    fs.writeFileSync(path.join(temporary, 'nested', 'nested.mov'), 'video');
    assert.deepStrictEqual(
      transcriptMediaInputs(temporary).map((filename) => path.basename(filename)),
      ['a.mp4', 'B.MP3', 'c.m4a']
    );
    assert.deepStrictEqual(transcriptMediaInputs(path.join(temporary, 'B.MP3')), [path.join(temporary, 'B.MP3')]);
    assert.throws(() => transcriptMediaInputs(path.join(temporary, 'ignore.txt')), /Unsupported media/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('transcript directory mode skips an existing backend transcript', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'generate-transcript-skip-'));
  try {
    fs.writeFileSync(path.join(temporary, 'lesson.mp4'), 'video');
    fs.writeFileSync(path.join(temporary, 'lesson.faster-whisper.srt'), 'existing');
    assert.strictEqual(transcriptMain([temporary]), 0);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('quality migration flags are isolated and audit implies simulation', () => {
  const audit = parseArchiveArguments(['--migrate-quality-audit']);
  assert.strictEqual(audit.migrateQuality, true);
  assert.strictEqual(audit.simulate, true);
  assert.strictEqual(parseArchiveArguments(['--migrate-quality', '--dry-run']).simulate, true);
  assert.strictEqual(parseArchiveArguments(['--migrate-quality-revert']).migrateQualityRevert, true);
  assert.throws(() => parseArchiveArguments(['--migrate-quality-restore']), /Unknown argument/u);
  assert.throws(
    () => parseArchiveArguments(['--migrate-quality', '--migrate-quality-revert']),
    /mutually exclusive/u
  );
});

test('list flags support all groups or one exact group', () => {
  assert.strictEqual(parseArchiveArguments(['--list']).list, true);
  assert.strictEqual(parseArchiveArguments(['--list', 'Example Channel/Videos']).listGroup, 'Example Channel/Videos');
  assert.strictEqual(parseArchiveArguments(['--list=ExampleChannel/Videos']).listGroup, 'ExampleChannel/Videos');
  assert.strictEqual(parseArchiveArguments(['--list-groups']).listGroups, true);
  assert.strictEqual(parseArchiveArguments(['--list-details', 'ExampleChannel/Videos']).listDetails, true);
  assert.strictEqual(parseArchiveArguments(['--list-details=ExampleChannel/Videos']).listGroup, 'ExampleChannel/Videos');
  assert.strictEqual(parseArchiveArguments(['--validate']).validate, true);
  assert.strictEqual(parseArchiveArguments(['--validate', 'ExampleChannel/Videos']).listGroup, 'ExampleChannel/Videos');
  assert.throws(() => parseArchiveArguments(['--listm']), /Unknown argument/u);
  assert.throws(() => parseArchiveArguments(['--list', '--list-groups']), /mutually exclusive/u);
});

test('a positional group focuses a normal run and overrides its enable setting', () => {
  assert.strictEqual(parseArchiveArguments(['DrawingDownTheDragon']).runGroup, 'DrawingDownTheDragon');
  assert.throws(() => parseArchiveArguments(['one', 'two']), /Unknown argument/u);
  const config = {
    targets: [
      { directory: 'Other', enable: 1 },
      { directory: 'DrawingDownTheDragon', enable: 0 }
    ],
    linkRules: [
      { sourceDirectory: 'Other' },
      { sourceDirectory: 'DrawingDownTheDragon' }
    ],
    transcriptDirectories: ['Other', 'DrawingDownTheDragon'],
    postSteps: [{ command: 'global-step' }]
  };
  const focused = focusConfig(config, 'DrawingDownTheDragon');
  assert.deepStrictEqual(focused.targets, [{ directory: 'DrawingDownTheDragon', enable: 1, enabled: true }]);
  assert.deepStrictEqual(focused.linkRules, [{ sourceDirectory: 'DrawingDownTheDragon' }]);
  assert.deepStrictEqual(focused.transcriptDirectories, ['DrawingDownTheDragon']);
  assert.deepStrictEqual(focused.postSteps, []);
  assert.throws(() => focusConfig(config, 'Missing'), /Unknown group/u);
});

test('archive validation reports only incomplete top-level companion sets', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'video-archiver-validate-'));
  try {
    const group = 'Example/Videos';
    const directory = path.join(temporary, group);
    fs.mkdirSync(path.join(directory, '720p'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'archive.txt'), 'youtube complete123\nyoutube generated12\nyoutube renamed1234\nyoutube bracket1234\nyoutube missing456\n');
    fs.writeFileSync(path.join(directory, 'Complete.mp4'), 'video');
    fs.writeFileSync(path.join(directory, 'Complete.info.json'), JSON.stringify({ id: 'complete123' }));
    fs.writeFileSync(path.join(directory, 'Complete-complete123.en.srt'), 'subtitle');
    fs.writeFileSync(path.join(directory, 'Complete.srt.json'), '[]');
    fs.writeFileSync(path.join(directory, 'Generated.mp4'), 'video');
    fs.writeFileSync(path.join(directory, 'Generated.info.json'), JSON.stringify({ id: 'generated12' }));
    fs.writeFileSync(path.join(directory, 'Generated.faster-whisper.srt'), 'generated subtitle');
    fs.writeFileSync(path.join(directory, 'Generated.faster-whisper.srt.json'), '[]');
    fs.writeFileSync(path.join(directory, 'Needs_assets.mp4'), 'video');
    fs.writeFileSync(path.join(directory, '720p', 'Needs assets-oldid.en.srt'), 'legacy subtitle');
    fs.writeFileSync(path.join(directory, 'Renamed_video.mp4'), 'video');
    fs.writeFileSync(path.join(directory, 'Renamed_video-renamed1234.en.srt'), 'subtitle');
    fs.writeFileSync(path.join(directory, 'Renamed_video.srt.json'), '[]');
    fs.writeFileSync(path.join(directory, '20230804-Bracketed video [bracket1234].mp4'), 'video');
    fs.writeFileSync(path.join(directory, 'Metadata_only.info.json'), JSON.stringify({ id: 'metadata789' }));
    fs.writeFileSync(path.join(directory, 'Playlist.info.json'), JSON.stringify({ id: 'playlist123', _type: 'playlist' }));
    const config = {
      archiveDirectory: temporary, workingDirectory: temporary,
      targets: [{ directory: group }]
    };
    assert.deepStrictEqual(validateGroup(config, group), [
      ['20230804-Bracketed video [bracket1234].mp4', ['.srt', '.info.json']],
      ['archive ID missing456', ['.mp4', '.info.json', '.srt']],
      ['Metadata_only.mp4', ['.mp4', '.srt']],
      ['Needs_assets.mp4', ['.srt', '.info.json']],
      ['Renamed_video.mp4', ['.info.json']]
    ]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('archive validation displays quoted titles without the MP4 suffix', () => {
  assert.strictEqual(displayAsset('Explicit Information.mp4'), '"Explicit Information"');
  assert.strictEqual(displayAsset('archive ID abc123'), 'archive ID abc123');
});

test('detailed asset labels show codecs and align filenames', () => {
  const av1 = assetDetails({ streams: [
    { codec_type: 'video', codec_name: 'av1', width: 1280, height: 720 },
    { codec_type: 'audio', codec_name: 'aac' }
  ] });
  const h264 = assetDetails({ streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { codec_type: 'audio', codec_name: 'aac' }
  ] });
  const widths = { resolution: 0, videoCodec: 0, audioCodec: 0 };
  updateDetailWidths(widths, av1);
  assert.strictEqual(assetDetailLabel(av1, widths), '[1280x720:av1:aac]');
  updateDetailWidths(widths, h264);
  assert.strictEqual(formatDetailedRow('later-av1.mp4', av1, widths, 3 * 1024 * 1024), '[1280x720 :av1 :aac]  later-av1.mp4  [3.00M]');
  assert.strictEqual(formatDetailedRow('h264.mp4', h264, widths, 6 * 1024 * 1024 * 1024), '[1920x1080:h264:aac]  h264.mp4  [6.00G]');
  assert.strictEqual(humanFileSize(1024), '1.00k');
  assert.strictEqual(humanFileSize(1536), '1.50k');
});

test('asset listing deduplicates configured groups and recursively lists MP4 files', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'video-archiver-list-'));
  try {
    const group = path.join(temporary, 'ExampleChannel', 'Videos');
    fs.mkdirSync(path.join(group, 'Season 2'), { recursive: true });
    fs.writeFileSync(path.join(group, 'Second.mp4'), 'video');
    fs.writeFileSync(path.join(group, 'First.info.json'), '{}');
    fs.writeFileSync(path.join(group, 'Season 2', 'First.MP4'), 'video');
    const config = {
      workingDirectory: temporary,
      archiveDirectory: '.',
      targets: [
        { directory: 'ExampleChannel/Videos' },
        { directory: 'ExampleChannel/Videos' },
        { directory: 'ExampleChannel/Streams', enable: 0 }
      ]
    };
    assert.deepStrictEqual(configuredGroups(config), ['ExampleChannel/Videos', 'ExampleChannel/Streams']);
    assert.deepStrictEqual(assetsInGroup(config, 'ExampleChannel/Videos'), [path.join('Season 2', 'First.MP4'), 'Second.mp4']);
    assert.deepStrictEqual(selectGroups(config, 'ExampleChannel/Streams'), ['ExampleChannel/Streams']);
    assert.throws(() => selectGroups(config, 'Unknown'), /Unknown group/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('quality backups use cwd state and preserve the target hierarchy', () => {
  const config = { workingDirectory: '/archive', archiveDirectory: '.', configDirectory: '/config' };
  const tools = { appDirectory: '/config/.update-youtube', stateDirectory: '/archive/.update-youtube' };
  assert.strictEqual(
    backupDirectory(config, tools, { directory: 'ExampleChannel/Videos' }),
    path.resolve('/archive/.update-youtube/backups/ExampleChannel/Videos')
  );
});

test('quality comparison prefers resolution before codec and parses selected formats', () => {
  const existing = { width: 1280, height: 720, videoCodec: 'h264', fps: 30, videoBitrate: 1, audioCodec: 'aac', audioBitrate: 1 };
  const candidate = selectedStreams({
    duration: 10,
    requested_formats: [
      { width: 1920, height: 1080, fps: 30, vcodec: 'av01.0.08M.08', acodec: 'none', vbr: 1000, ext: 'mp4' },
      { vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, ext: 'm4a' }
    ]
  });
  assert.strictEqual(candidate.videoCodec, 'av1');
  assert.strictEqual(candidate.audioCodec, 'aac');
  assert.match(compareQuality(existing, candidate), /^resolution/u);
  assert.strictEqual(compareQuality({ ...existing, width: 1920, height: 1080 }, { ...candidate, width: 1280, height: 720 }), null);
});

test('quality replacement keeps a durable transaction and installs both files', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'video-archiver-quality-install-'));
  try {
    const stateDirectory = path.join(temporary, '.update-youtube');
    const pair = {
      id: 'video123',
      video: path.join(temporary, 'Archived.mp4'),
      info: path.join(temporary, 'Archived.info.json')
    };
    const candidateVideo = path.join(temporary, 'candidate.mp4');
    const candidateInfo = path.join(temporary, 'candidate.info.json');
    fs.writeFileSync(pair.video, 'old video');
    fs.writeFileSync(pair.info, 'old info');
    fs.writeFileSync(candidateVideo, 'new video');
    fs.writeFileSync(candidateInfo, 'new info');
    qualityTest.installPair({ stateDirectory }, pair, candidateVideo, candidateInfo, 'test');
    assert.strictEqual(fs.readFileSync(pair.video, 'utf8'), 'new video');
    assert.strictEqual(fs.readFileSync(pair.info, 'utf8'), 'new info');
    const transactions = fs.readdirSync(path.join(stateDirectory, 'quality-transactions'));
    assert.strictEqual(transactions.length, 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(stateDirectory, 'quality-transactions', transactions[0]))).status, 'complete');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('quality recovery restores originals after an interrupted replacement', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'video-archiver-quality-recovery-'));
  try {
    const stateDirectory = path.join(temporary, '.update-youtube');
    const transactions = path.join(stateDirectory, 'quality-transactions');
    const pair = { id: 'video123', video: path.join(temporary, 'Archived.mp4'), info: path.join(temporary, 'Archived.info.json') };
    const oldVideo = `${pair.video}.quality-old`;
    const oldInfo = `${pair.info}.quality-old`;
    const newVideo = `${pair.video}.quality-new`;
    const newInfo = `${pair.info}.quality-new`;
    fs.mkdirSync(transactions, { recursive: true });
    fs.writeFileSync(pair.video, 'partially installed video');
    fs.writeFileSync(pair.info, 'partially installed info');
    fs.writeFileSync(oldVideo, 'original video');
    fs.writeFileSync(oldInfo, 'original info');
    fs.writeFileSync(newVideo, 'unused candidate video');
    fs.writeFileSync(newInfo, 'unused candidate info');
    fs.writeFileSync(path.join(transactions, 'pending.json'), JSON.stringify({
      operation: 'test', status: 'installed', pair, oldVideo, oldInfo, newVideo, newInfo
    }));
    qualityTest.recoverTransactions({ stateDirectory });
    assert.strictEqual(fs.readFileSync(pair.video, 'utf8'), 'original video');
    assert.strictEqual(fs.readFileSync(pair.info, 'utf8'), 'original info');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(transactions, 'pending.json'))).status, 'rolled-back');
    const recovered = path.join(stateDirectory, 'quality-recovery');
    assert(fs.existsSync(recovered));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('process failures retain structured stderr without leaking executable paths', () => {
  let failure;
  try {
    run(process.execPath, ['-e', "process.stderr.write('clean failure'); process.exit(7)"], {
      capture: true,
      quiet: true,
      errorLabel: 'test tool'
    });
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof ProcessError);
  assert.strictEqual(failure.message, 'test tool exited with status 7');
  assert.strictEqual(formatProcessError(failure), 'clean failure');
  assert.strictEqual(failure.outputDisplayed, false);
});

test('streamed commands can retain stderr for failure classification', () => {
  let failure;
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    run(process.execPath, ['-e', "process.stderr.write('HTTP Error 429: Too Many Requests'); process.exit(1)"], {
      captureStderr: true, quiet: true, errorLabel: 'test command'
    });
  } catch (error) {
    failure = error;
  } finally {
    process.stderr.write = originalWrite;
  }
  assert(failure instanceof ProcessError);
  assert.match(failure.stderr, /429/u);
  assert.strictEqual(failure.outputDisplayed, true);
});

test('terminal errors are red while redirected output remains plain', () => {
  assert.strictEqual(errorText('[ERROR] failed', false), '[ERROR] failed');
  assert.strictEqual(errorText('[ERROR] failed', true), '\u001b[31;1m[ERROR] failed\u001b[0m');
  assert.strictEqual(
    colorErrorLines('before\nERROR: Too Many Requests\nafter\n', true),
    'before\n\u001b[31;1mERROR: Too Many Requests\u001b[0m\nafter\n'
  );
});

test('naming modes preserve Bash output formats', () => {
  assert.strictEqual(outputFormat(0), '%(title)s.%(ext)s');
  assert.strictEqual(outputFormat(1), '%(upload_date)s-%(title)s.%(ext)s');
  assert.strictEqual(outputFormat(0, true), '%(title)s-%(id)s.%(ext)s');
  assert.strictEqual(outputFormat(1, true), '%(upload_date)s-%(title)s-%(id)s.%(ext)s');
  assert.strictEqual(outputFormat(2, true), null);
});

test('video quality format comes from config with a backward-compatible default', () => {
  const legacy = videoFormat({});
  assert(legacy.includes('height<=1080'));
  assert.strictEqual(videoFormat({ quality: { videoFormat: 'custom-format' } }), 'custom-format');
});

test('example naming profiles preserve supported formats', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'example.config.json'), 'utf8'));
  assert.strictEqual(config.namingProfiles.title.video, '%(title)s.%(ext)s');
  assert.strictEqual(config.namingProfiles.dated.video, '%(upload_date)s-%(title)s.%(ext)s');
  assert.strictEqual(config.namingProfiles['title-with-id'].video, '%(title)s [%(id)s].%(ext)s');
  assert.strictEqual(config.namingProfiles['dated-with-id'].video, '%(upload_date)s-%(title)s [%(id)s].%(ext)s');
  assert(config.targets.every((target) => target.namingProfile));
  assert(config.targets.every((target) => target.enable === 0 || target.enable === 1));
});

test('SRT conversion preserves expected schema and handles CRLF', () => {
  const result = convertSrtText('1\r\n00:00:01,000 --> 00:00:02,000\r\nHello world\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\nHello world again\r\n');
  assert.deepStrictEqual(result, [
    { start: '00:00:01,000', end: '00:00:02,000', text: 'Hello world' },
    { start: '00:00:02,000', end: '00:00:03,000', text: 'again' }
  ]);
});

test('missing info JSON is backfilled from an archived video ID', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'video-archiver-backfill-'));
  try {
    const targetDirectory = path.join(temporary, 'videos');
    const fakeYtDlp = path.join(temporary, 'fake-yt-dlp');
    fs.mkdirSync(targetDirectory);
    fs.writeFileSync(path.join(targetDirectory, 'Legacy Title.mp4'), 'video');
    fs.writeFileSync(path.join(targetDirectory, 'Manual Video [BQ2SAA08k7k].mp4'), 'video');
    fs.writeFileSync(path.join(targetDirectory, '._Legacy Title.info.json'), 'AppleDouble');
    fs.writeFileSync(path.join(targetDirectory, 'archive.txt'), 'youtube abc123\n');
    fs.writeFileSync(fakeYtDlp, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--dump-single-json')) {
  const standalone = args.some((value) => value.includes('BQ2SAA08k7k'));
  process.stdout.write(JSON.stringify(standalone
    ? { id: 'BQ2SAA08k7k', title: 'Current YouTube Title', ext: 'mp4' }
    : { id: 'abc123', title: 'Legacy Title', ext: 'mp4' }));
} else if (args.includes('--load-info-json')) {
  process.stdout.write(args.includes('--restrict-filenames') ? 'Legacy_Title.mp4\\n' : 'Legacy Title.mp4\\n');
} else process.exitCode = 2;
`);
    fs.chmodSync(fakeYtDlp, 0o755);
    const config = {
      configDirectory: temporary,
      workingDirectory: temporary,
      archiveDirectory: '.',
      cookies: {},
      namingProfiles: { title: { video: '%(title)s.%(ext)s' } },
      targets: [{ enable: 1, directory: 'videos', namingProfile: 'title', url: 'unused' }]
    };
    backfillInfo(config, {
      ytDlp: fakeYtDlp,
      ffmpeg: '/unused/ffmpeg',
      jsRuntime: { name: 'deno', command: '/unused/deno' },
      appDirectory: temporary
    }, { simulate: false, skipInfoBackfill: false });
    const metadata = JSON.parse(fs.readFileSync(path.join(targetDirectory, 'Legacy Title.info.json'), 'utf8'));
    assert.strictEqual(metadata.id, 'abc123');
    const standalone = JSON.parse(fs.readFileSync(path.join(targetDirectory, 'Manual Video [BQ2SAA08k7k].info.json'), 'utf8'));
    assert.strictEqual(standalone.id, 'BQ2SAA08k7k');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('YouTube IDs are recognized only in supported filename suffixes', () => {
  assert.strictEqual(archiveTest.youtubeIdFromFilename('Title [BQ2SAA08k7k].mp4'), 'BQ2SAA08k7k');
  assert.strictEqual(archiveTest.youtubeIdFromFilename('Title-BQ2SAA08k7k.mp4'), 'BQ2SAA08k7k');
  assert.strictEqual(archiveTest.youtubeIdFromFilename('BQ2SAA08k7k appears in title.mp4'), null);
});

test('standalone ID subtitles are renamed beside the exact MP4 stem', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'video-archiver-standalone-subtitle-'));
  try {
    fs.writeFileSync(path.join(temporary, 'archive.txt'), '');
    fs.writeFileSync(path.join(temporary, 'Manual Name [BQ2SAA08k7k].mp4'), 'video');
    fs.writeFileSync(path.join(temporary, 'Current_YouTube_Title-BQ2SAA08k7k.en.srt'), 'subtitle');
    fs.writeFileSync(path.join(temporary, 'Current_YouTube_Title-BQ2SAA08k7k.en.srt.json'), '[]');
    archiveTest.fetchSubtitles({ cookies: {} }, {}, temporary, {
      directory: 'videos', archive: 'archive.txt'
    }, { simulate: false });
    assert.strictEqual(fs.existsSync(path.join(temporary, 'Manual Name [BQ2SAA08k7k].en.srt')), true);
    assert.strictEqual(fs.existsSync(path.join(temporary, 'Manual Name [BQ2SAA08k7k].en.srt.json')), true);
    assert.strictEqual(fs.existsSync(path.join(temporary, 'Manual Name [BQ2SAA08k7k].srt.json')), false);
    assert.strictEqual(fs.existsSync(path.join(temporary, 'Current_YouTube_Title-BQ2SAA08k7k.en.srt')), false);
    assert.strictEqual(fs.existsSync(path.join(temporary, 'Current_YouTube_Title-BQ2SAA08k7k.en.srt.json')), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('archived IDs with missing files are explicitly refetched', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'video-archiver-repair-'));
  try {
    const targetDirectory = path.join(temporary, 'videos');
    const fakeYtDlp = path.join(temporary, 'fake-yt-dlp');
    fs.mkdirSync(targetDirectory);
    fs.writeFileSync(path.join(targetDirectory, 'archive.txt'), 'youtube missing123\n');
    fs.writeFileSync(fakeYtDlp, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync('Recovered.mp4', 'video');
fs.writeFileSync('Recovered.info.json', JSON.stringify({ id: 'missing123' }));
`);
    fs.chmodSync(fakeYtDlp, 0o755);
    const config = {
      configDirectory: temporary,
      workingDirectory: temporary,
      archiveDirectory: '.',
      cookies: {},
      namingProfiles: { title: { video: '%(title)s.%(ext)s' } },
      targets: [{ enable: 1, directory: 'videos', namingProfile: 'title', url: 'unused' }]
    };
    repairArchivedVideos(config, {
      ytDlp: fakeYtDlp,
      ffmpeg: '/unused/ffmpeg',
      jsRuntime: { name: 'deno', command: '/unused/deno' },
      appDirectory: temporary
    }, { simulate: false, skipInfoBackfill: false });
    assert(fs.existsSync(path.join(targetDirectory, 'Recovered.mp4')));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(targetDirectory, 'Recovered.info.json'))).id, 'missing123');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('example link rules produce curated names', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'example.config.json'), 'utf8'));
  const episode = config.linkRules[0];
  const source = '.ExampleChannel/.Incoming/Episode 3 - Sample.mp4';
  assert.strictEqual(
    source.replace(new RegExp(episode.pattern, episode.flags || 'u'), episode.replacement),
    'ExampleChannel/Organized/Episode 03 - Sample.mp4'
  );
});

test('pending migrations resume safely after an interrupted move', () => {
  const temporary = fs.mkdtempSync(path.join(require('os').tmpdir(), 'video-archiver-migration-'));
  try {
    const appDirectory = path.join(temporary, 'shared-tools');
    const stateDirectory = path.join(temporary, '.update-youtube');
    const migrations = path.join(stateDirectory, 'migrations');
    const sourceOne = path.join(temporary, 'old-one.mp4');
    const destinationOne = path.join(temporary, 'new-one.mp4');
    const sourceTwo = path.join(temporary, 'old-two.json');
    const destinationTwo = path.join(temporary, 'new-two.json');
    fs.mkdirSync(migrations, { recursive: true });
    fs.writeFileSync(sourceOne, 'video');
    fs.writeFileSync(destinationTwo, 'metadata');
    const manifest = path.join(migrations, 'pending.json');
    fs.writeFileSync(manifest, `${JSON.stringify({
      createdAt: new Date().toISOString(),
      status: 'pending',
      moves: [
        { source: sourceOne, destination: destinationOne, description: 'video', status: 'pending' },
        { source: sourceTwo, destination: destinationTwo, description: 'metadata', status: 'pending' }
      ]
    })}\n`);
    const result = handleMigrations(
      { configDirectory: temporary, workingDirectory: temporary, archiveDirectory: '.', targets: [] },
      { appDirectory, stateDirectory },
      { apply: true, simulate: false }
    );
    assert.deepStrictEqual(result, { required: true, applied: true });
    assert.strictEqual(fs.readFileSync(destinationOne, 'utf8'), 'video');
    const completed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert.strictEqual(completed.status, 'complete');
    assert(completed.moves.every((move) => move.status === 'complete'));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

if (failures) process.exitCode = 1;
else console.log('All tests passed.');
