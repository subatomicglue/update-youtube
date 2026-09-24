'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { findConfigPath, mergeConfig, resolveArchive } = require('../lib/config');
const { backfillInfo, outputFormat, repairArchivedVideos, videoFormat } = require('../lib/archive');
const { convertSrtText } = require('../lib/subtitles');
const { handleMigrations } = require('../lib/migrate');
const { formatProcessError, ProcessError, run } = require('../lib/process');
const { meetsRequirements, parseArguments: parseVideoCheckArguments } = require('../check-video-resolution');

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
    fs.writeFileSync(path.join(targetDirectory, '._Legacy Title.info.json'), 'AppleDouble');
    fs.writeFileSync(path.join(targetDirectory, 'archive.txt'), 'youtube abc123\n');
    fs.writeFileSync(fakeYtDlp, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--dump-single-json')) {
  process.stdout.write(JSON.stringify({ id: 'abc123', title: 'Legacy Title', ext: 'mp4' }));
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
