'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { run } = require('./process');
const { resolveFromConfig } = require('./config');

function platformKey() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

function executableName(tool) {
  return process.platform === 'win32' ? `${tool}.exe` : tool;
}

function commandExists(command) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  return run(checker, [command], { capture: true, allowFailure: true, quiet: true }).status === 0;
}

function resolveCommand(command) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = run(checker, [command], { capture: true, allowFailure: true, quiet: true });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
}

function download(url, destination, redirects = 0) {
  if (redirects > 10) return Promise.reject(new Error(`Too many redirects downloading ${url}`));
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'update-youtube' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        resolve(download(next, destination, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed (${response.statusCode}): ${url}`));
        return;
      }
      const temporary = `${destination}.download`;
      const output = fs.createWriteStream(temporary);
      response.pipe(output);
      output.on('finish', () => {
        output.close(() => {
          fs.renameSync(temporary, destination);
          resolve();
        });
      });
      output.on('error', reject);
    });
    request.on('error', reject);
  });
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'update-youtube', Accept: 'application/vnd.github+json' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`GitHub API failed (${response.statusCode})`));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

function findFile(directory, name) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return filename;
    if (entry.isDirectory()) {
      const found = findFile(filename, name);
      if (found) return found;
    }
  }
  return null;
}

function clearMacQuarantine(directory, label) {
  if (process.platform !== 'darwin') return;
  const result = run('xattr', ['-cr', directory], { allowFailure: true, capture: true, quiet: true });
  if (result.status !== 0) console.warn(`[macOS] unable to clear quarantine attributes from ${directory}`);
}

function versionDirectory(toolDirectory, version) {
  return path.join(toolDirectory, 'versions', String(version).replace(/[^a-zA-Z0-9._-]/gu, '_'));
}

function writeCurrent(toolDirectory, version, binary) {
  const current = path.join(toolDirectory, 'current.json');
  const temporary = `${current}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version, binary }, null, 2)}\n`);
  if (process.platform === 'win32' && fs.existsSync(current)) fs.unlinkSync(current);
  fs.renameSync(temporary, current);
}

function readCurrent(toolDirectory) {
  const current = path.join(toolDirectory, 'current.json');
  if (!fs.existsSync(current)) return null;
  try {
    return JSON.parse(fs.readFileSync(current, 'utf8'));
  } catch (error) {
    return null;
  }
}

function validateExecutable(binary, args, expected, label) {
  if (!fs.existsSync(binary)) throw new Error(`${label} executable is missing: ${binary}`);
  const result = run(binary, args, { capture: true, allowFailure: true, quiet: true });
  if (result.status !== 0) throw new Error(`${label} validation failed: ${binary}`);
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (expected && !output.includes(String(expected).replace(/^v/u, ''))) {
    throw new Error(`${label} reported an unexpected version (${output || 'no version output'}; expected ${expected}).`);
  }
  return output;
}

function moveInvalidInstallation(directory) {
  if (!fs.existsSync(directory)) return;
  const invalid = `${directory}.invalid-${Date.now()}`;
  fs.renameSync(directory, invalid);
  console.warn(`[tools] preserved invalid installation at ${invalid}`);
}

async function updateYtDlp(config, appDirectory) {
  const settings = config.tools.ytDlp[platformKey()];
  if (settings.system) {
    if (!commandExists(settings.command || 'yt-dlp')) throw new Error('yt-dlp was not found on PATH.');
    return settings.command || 'yt-dlp';
  }
  const toolDirectory = path.join(appDirectory, 'yt-dlp');
  fs.mkdirSync(toolDirectory, { recursive: true });
  const release = await requestJson(config.tools.ytDlp.releaseApi);
  const asset = release.assets.find((item) => item.name === settings.asset);
  if (!asset) throw new Error(`${settings.asset} was not found in yt-dlp release ${release.tag_name}.`);
  const installedDirectory = versionDirectory(toolDirectory, release.tag_name);
  const binary = path.join(installedDirectory, settings.binary);
  let valid = false;
  if (fs.existsSync(installedDirectory)) {
    try {
      clearMacQuarantine(installedDirectory, 'yt-dlp');
      validateExecutable(binary, ['--version'], release.tag_name, 'yt-dlp');
      valid = true;
    } catch (error) {
      console.warn(`[yt-dlp] cached ${release.tag_name} is invalid: ${error.message}`);
      moveInvalidInstallation(installedDirectory);
    }
  }
  if (!valid) {
    const staging = path.join(toolDirectory, 'versions', `.${release.tag_name}.partial-${process.pid}`);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    const downloaded = path.join(staging, settings.asset);
    await download(asset.browser_download_url, downloaded);
    if (settings.archive === 'zip') {
      run(process.platform === 'win32' ? 'tar' : 'unzip', process.platform === 'win32'
        ? ['-xf', downloaded, '-C', staging]
        : ['-o', downloaded, '-d', staging], { capture: true, quiet: true });
    }
    const stagedBinary = path.join(staging, settings.binary);
    if (!fs.existsSync(stagedBinary)) {
      const found = findFile(staging, path.basename(settings.binary));
      if (!found) throw new Error(`Installed yt-dlp binary not found: ${settings.binary}`);
      fs.copyFileSync(found, stagedBinary);
    }
    if (process.platform !== 'win32') fs.chmodSync(stagedBinary, 0o755);
    clearMacQuarantine(staging, 'staged yt-dlp');
    validateExecutable(stagedBinary, ['--version'], release.tag_name, 'yt-dlp');
    fs.renameSync(staging, installedDirectory);
    console.log(`[yt-dlp] installed new version ${release.tag_name}`);
  }
  writeCurrent(toolDirectory, release.tag_name, binary);
  clearMacQuarantine(installedDirectory, 'yt-dlp');
  return binary;
}

async function ensureFfmpeg(config, appDirectory) {
  let ffmpeg = resolveCommand('ffmpeg');
  let ffprobe = resolveCommand('ffprobe');
  if (ffmpeg && ffprobe) {
    verifyFfmpeg(ffmpeg, ffprobe);
    return ffmpeg;
  }

  const installer = detectFfmpegInstaller();
  const missing = [!ffmpeg && 'ffmpeg', !ffprobe && 'ffprobe'].filter(Boolean).join(' and ');
  if (!installer) {
    throw new Error(`${missing} not found on PATH. Install FFmpeg with your OS package manager, ensure ffmpeg and ffprobe are on PATH, then retry.`);
  }
  console.log(`\n[ffmpeg] ${missing} not found on PATH.`);
  console.log(`[ffmpeg] Recommended install command: ${installer.display}`);
  if (!process.stdin.isTTY || !askYesNo('[ffmpeg] Run this package-manager command for you? [y/N] ')) {
    throw new Error(`FFmpeg is required. Run "${installer.display}", ensure ffmpeg and ffprobe are on PATH, then retry.`);
  }
  run(installer.command, installer.args);
  ffmpeg = resolveCommand('ffmpeg');
  ffprobe = resolveCommand('ffprobe');
  if (!ffmpeg || !ffprobe) {
    throw new Error('FFmpeg installation completed, but ffmpeg/ffprobe are not visible on PATH. Open a new terminal, update PATH if necessary, and retry.');
  }
  const version = verifyFfmpeg(ffmpeg, ffprobe);
  console.log(`[ffmpeg] installed new version ${version}`);
  return ffmpeg;
}

function askYesNo(question) {
  fs.writeSync(process.stdout.fd, question);
  const buffer = Buffer.alloc(32);
  const count = fs.readSync(process.stdin.fd, buffer, 0, buffer.length, null);
  return /^y(?:es)?$/iu.test(buffer.toString('utf8', 0, count).trim());
}

function withElevation(command, args) {
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    return { command, args, display: [command, ...args].join(' ') };
  }
  const elevation = commandExists('sudo') ? 'sudo' : (commandExists('doas') ? 'doas' : null);
  if (!elevation) return null;
  return { command: elevation, args: [command, ...args], display: [elevation, command, ...args].join(' ') };
}

function detectFfmpegInstaller() {
  if (process.platform === 'darwin') {
    return commandExists('brew')
      ? { command: 'brew', args: ['install', 'ffmpeg'], display: 'brew install ffmpeg' }
      : null;
  }
  if (process.platform === 'win32') {
    return commandExists('winget')
      ? { command: 'winget', args: ['install', '--id', 'Gyan.FFmpeg', '--exact', '--accept-package-agreements', '--accept-source-agreements'], display: 'winget install --id Gyan.FFmpeg --exact' }
      : null;
  }
  const candidates = [
    ['apt-get', ['install', 'ffmpeg']],
    ['dnf', ['install', 'ffmpeg']],
    ['yum', ['install', 'ffmpeg']],
    ['pacman', ['-S', 'ffmpeg']],
    ['apk', ['add', 'ffmpeg']]
  ];
  for (const [command, args] of candidates) {
    if (commandExists(command)) return withElevation(command, args);
  }
  return null;
}

function verifyFfmpeg(ffmpeg, ffprobe) {
  const ffmpegResult = run(ffmpeg, ['-version'], { capture: true, allowFailure: true, quiet: true });
  const ffprobeResult = run(ffprobe, ['-version'], { capture: true, allowFailure: true, quiet: true });
  if (ffmpegResult.status !== 0 || ffprobeResult.status !== 0) {
    throw new Error('ffmpeg and ffprobe were found, but their version checks failed.');
  }
  const version = /^ffmpeg version\s+(\S+)/mu.exec(ffmpegResult.stdout);
  return version ? version[1] : 'compatible';
}

async function ensureDeno(config, appDirectory) {
  const settings = config.tools.deno[platformKey()];
  if (settings.currentNode) {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 20) throw new Error('yt-dlp requires Node.js 20 or newer as its JavaScript runtime on Linux.');
    return { name: 'node', command: process.execPath };
  }
  if (settings.system) {
    const command = settings.command || 'deno';
    if (!commandExists(command)) throw new Error(`${command} was not found on PATH.`);
    return { name: 'deno', command };
  }
  const toolDirectory = path.join(appDirectory, 'deno');
  fs.mkdirSync(toolDirectory, { recursive: true });
  const release = await requestJson(config.tools.deno.releaseApi);
  const assetName = settings.assets[process.arch];
  if (!assetName) throw new Error(`No Deno download is configured for ${platformKey()}/${process.arch}.`);
  const installedDirectory = versionDirectory(toolDirectory, release.tag_name);
  const binary = path.join(installedDirectory, executableName('deno'));
  let valid = false;
  if (fs.existsSync(installedDirectory)) {
    try {
      clearMacQuarantine(installedDirectory, 'Deno');
      validateExecutable(binary, ['--version'], release.tag_name, 'Deno');
      valid = true;
    } catch (error) {
      console.warn(`[deno] cached ${release.tag_name} is invalid: ${error.message}`);
      moveInvalidInstallation(installedDirectory);
    }
  }
  if (!valid) {
    const asset = release.assets.find((item) => item.name === assetName);
    if (!asset) throw new Error(`${assetName} was not found in Deno release ${release.tag_name}.`);
    const staging = path.join(toolDirectory, 'versions', `.${release.tag_name}.partial-${process.pid}`);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    const archive = path.join(staging, assetName);
    await download(asset.browser_download_url, archive);
    run(process.platform === 'win32' ? 'tar' : 'unzip', process.platform === 'win32'
      ? ['-xf', archive, '-C', staging]
      : ['-o', archive, '-d', staging], { capture: true, quiet: true });
    const stagedBinary = path.join(staging, executableName('deno'));
    if (!fs.existsSync(stagedBinary)) throw new Error('Deno executable was not found after extraction.');
    if (process.platform !== 'win32') fs.chmodSync(stagedBinary, 0o755);
    clearMacQuarantine(staging, 'staged Deno');
    validateExecutable(stagedBinary, ['--version'], release.tag_name, 'Deno');
    fs.renameSync(staging, installedDirectory);
    console.log(`[deno] installed new version ${release.tag_name}`);
  }
  writeCurrent(toolDirectory, release.tag_name, binary);
  clearMacQuarantine(installedDirectory, 'Deno');
  return { name: 'deno', command: binary };
}

async function ensureTools(config, options = {}) {
  // Keep reusable binaries beside the selected config, but keep mutable archive
  // state beneath cwd. One config may drive archives in several directories;
  // sharing migration/unavailable-video state between them can resume the wrong
  // migration or cause concurrent runs to overwrite one another's state.
  // These paths intentionally become the same when configDirectory === cwd.
  const appDirectory = resolveFromConfig(config, config.applicationDirectory || '.update-youtube');
  const stateDirectory = path.resolve(config.workingDirectory || process.cwd(), '.update-youtube');
  fs.mkdirSync(appDirectory, { recursive: true });
  fs.mkdirSync(stateDirectory, { recursive: true });
  const ytDlp = options.skipUpdate
    ? findExistingYtDlp(config, appDirectory)
    : await updateYtDlp(config, appDirectory);
  const ffmpeg = await ensureFfmpeg(config, appDirectory);
  const jsRuntime = await ensureDeno(config, appDirectory);
  return { ytDlp, ffmpeg, jsRuntime, appDirectory, stateDirectory };
}

function findExistingYtDlp(config, appDirectory) {
  const settings = config.tools.ytDlp[platformKey()];
  if (settings.system) return settings.command || 'yt-dlp';
  const toolDirectory = path.join(appDirectory, 'yt-dlp');
  const current = readCurrent(toolDirectory);
  const binary = current && current.binary
    ? current.binary
    : path.join(toolDirectory, settings.binary);
  if (!fs.existsSync(binary)) throw new Error('yt-dlp is not cached; run once without --skip-update.');
  clearMacQuarantine(path.dirname(binary), 'yt-dlp');
  validateExecutable(binary, ['--version'], current && current.version, 'yt-dlp');
  return binary;
}

module.exports = { ensureTools, platformKey };
