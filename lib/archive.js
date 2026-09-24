'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { formatProcessError, run } = require('./process');
const { resolveArchive, resolveFromConfig } = require('./config');
const { convertSrtFile } = require('./subtitles');
const { platformKey } = require('./tools');
const { targetProfile } = require('./migrate');

const DEFAULT_VIDEO_FORMAT = 'bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080] / bv*[height<=1080]+ba/b[height<=1080]';
const UNAVAILABLE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

function videoFormat(config) {
  const configured = config.quality && config.quality.videoFormat;
  return typeof configured === 'string' && configured.trim() ? configured : DEFAULT_VIDEO_FORMAT;
}

function unavailableStateFile(tools) {
  return path.join(tools.stateDirectory || tools.appDirectory, 'unavailable-videos.json');
}

function loadUnavailableState(tools) {
  const filename = unavailableStateFile(tools);
  if (!fs.existsSync(filename)) return {};
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    console.warn(`[state] ignoring unreadable unavailable-video state: ${error.message}`);
    return {};
  }
}

function saveUnavailableState(tools, state) {
  const filename = unavailableStateFile(tools);
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temporary, filename);
}

function unavailableKey(directory, id) {
  return `${path.resolve(directory)}\n${id}`;
}

function unavailableRecently(state, directory, id) {
  const entry = state[unavailableKey(directory, id)];
  return entry && Date.now() - Date.parse(entry.checkedAt) < UNAVAILABLE_RETRY_MS;
}

function isUnavailableError(error) {
  return /(?:video unavailable|private video|this video is unavailable)/iu.test(error.stderr || error.message);
}

function outputFormat(mode, transcript = false) {
  if (mode === 1) return transcript
    ? '%(upload_date)s-%(title)s-%(id)s.%(ext)s'
    : '%(upload_date)s-%(title)s.%(ext)s';
  if (mode === 2) return transcript
    ? null
    : '"%(title)s.%(ext)s" "%(upload_date)s" "%(title)s" "%(id)s" "%(ext)s"';
  return transcript ? '%(title)s-%(id)s.%(ext)s' : '%(title)s.%(ext)s';
}

function targetOutputFormat(config, target, transcript = false) {
  if (target.namingProfile) {
    const profile = targetProfile(config, target);
    return transcript ? (profile.subtitle || profile.video) : profile.video;
  }
  return outputFormat(Number(target.namingMode || 0), transcript);
}

function cookieArgs(config) {
  const browser = config.cookies && config.cookies[platformKey()];
  return browser ? ['--cookies-from-browser', browser] : [];
}

function assertCookieAccess(config) {
  const browser = config.cookies && config.cookies[platformKey()];
  if (process.platform !== 'darwin' || browser !== 'safari') return;
  const cookies = path.join(os.homedir(), 'Library', 'Cookies', 'Cookies.binarycookies');
  try {
    fs.accessSync(cookies, fs.constants.R_OK);
  } catch (error) {
    throw new Error('Safari cookies are not accessible from the application running this archiver. Grant that application Full Disk Access, fully restart it, and retry.');
  }
}

function downloadTarget(config, tools, target, options) {
  const errors = [];
  const directory = resolveArchive(config, target.directory);
  fs.mkdirSync(directory, { recursive: true });
  const mode = Number(target.namingMode || 0);
  console.log(`\n][-- [${target.directory}] --][`);
  const args = [
    ...(options.simulate ? ['--simulate'] : []),
    '--playlist-reverse',
    '--compat-options', 'no-youtube-unavailable-videos',
    '--match-filters', 'live_status != is_live & live_status != is_upcoming & live_status != post_live',
    '--restrict-filenames', '--sleep-requests', '2',
    '--min-sleep-interval', '5', '--max-sleep-interval', '15',
    '--sleep-subtitles', '3', '--write-info-json',
    ...cookieArgs(config), '--no-cache-dir', '--no-abort-on-error',
    '--no-overwrites', '--yes-playlist', '-i', '-f', videoFormat(config),
    '--ffmpeg-location', tools.ffmpeg,
    '--js-runtimes', `${tools.jsRuntime.name}:${tools.jsRuntime.command}`,
    '--output', targetOutputFormat(config, target),
    ...(mode === 2 ? ['--print', 'filename', '-q', '--no-warnings', '-s'] : ['--download-archive', target.archive || 'archive.txt']),
    ...(target.extraArgs || []), target.url
  ];
  try {
    run(tools.ytDlp, args, { cwd: directory, errorLabel: 'yt-dlp' });
  } catch (error) {
    errors.push(error.outputDisplayed ? null : `${target.directory}: video archive: ${formatProcessError(error)}`);
  }
  if (mode === 2) {
    console.log('[migration] Transcript fetching is intentionally disabled for naming mode 2.');
    return errors;
  }
  errors.push(...fetchSubtitles(config, tools, directory, target, options));
  return errors;
}

function fetchSubtitles(config, tools, directory, target, options) {
  const errors = [];
  const archive = path.join(directory, target.archive || 'archive.txt');
  if (!fs.existsSync(archive)) {
    if (!options.simulate) console.warn(`[transcript] archive not found: ${archive}`);
    return errors;
  }
  const ids = fs.readFileSync(archive, 'utf8').split(/\r?\n/).map((line) => line.trim().split(/\s+/).pop()).filter(Boolean);
  for (const id of ids) {
    let srt = findMatchingFile(directory, (name) => name.includes(id) && name.endsWith('.srt'));
    if (!srt) {
      console.log(`[transcript] No subtitles for ${id} yet, downloading...`);
      try {
        run(tools.ytDlp, [
          ...(options.simulate ? ['--simulate'] : []),
          '--restrict-filenames', '--write-auto-sub',
          '--sub-lang', target.subtitleLanguage || config.subtitleLanguage || 'en',
          '--convert-subs', 'srt', '--skip-download', '--no-overwrites', ...cookieArgs(config),
          '--ffmpeg-location', tools.ffmpeg, '--output', targetOutputFormat(config, target, true),
          '--js-runtimes', `${tools.jsRuntime.name}:${tools.jsRuntime.command}`,
          `https://youtu.be/${id}`
        ], { cwd: directory, errorLabel: 'yt-dlp' });
      } catch (error) {
        errors.push(error.outputDisplayed ? null : `${target.directory}: subtitle ${id}: ${formatProcessError(error)}`);
      }
      srt = findMatchingFile(directory, (name) => name.includes(id) && name.endsWith('.srt'));
    }
    if (!srt) {
      if (!options.simulate) console.warn(`[transcript] unable to get subtitles for ${id}`);
      continue;
    }
    const json = `${srt}.json`;
    if (!fs.existsSync(json)) {
      try {
        console.log(`[transcript] generated ${convertSrtFile(srt)}`);
      } catch (error) {
        errors.push(`${target.directory}: subtitle JSON ${id}: ${error.message}`);
      }
    }
  }
  return errors;
}

function findMatchingFile(directory, predicate) {
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isFile() && predicate(entry.name)) return filename;
      if (entry.isDirectory()) pending.push(filename);
    }
  }
  return null;
}

function renderedMp4Name(filename) {
  return `${path.basename(filename, path.extname(filename))}.mp4`;
}

function renderBackfillName(tools, infoJson, template, directory, restricted) {
  const result = run(tools.ytDlp, [
    '--load-info-json', infoJson, '--skip-download', '--ignore-no-formats-error',
    '--quiet', '--no-warnings', ...(restricted ? ['--restrict-filenames'] : []),
    '--print', 'filename', '--output', template
  ], { cwd: directory, capture: true, quiet: true, errorLabel: 'yt-dlp' });
  const lines = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error(`yt-dlp returned ${lines.length} filenames`);
  return renderedMp4Name(lines[0]);
}

function backfillInfo(config, tools, options) {
  if (options.skipInfoBackfill) return;
  const unavailable = loadUnavailableState(tools);
  let unavailableChanged = false;
  for (const target of config.targets || []) {
    if (target.enable === 0 || target.enabled === false) continue;
    const directory = resolveArchive(config, target.directory);
    const archive = path.join(directory, target.archive || 'archive.txt');
    if (!fs.existsSync(directory) || !fs.existsSync(archive)) continue;

    const entries = fs.readdirSync(directory, { withFileTypes: true });
    const missing = new Set(entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.mp4'))
      .map((entry) => entry.name)
      .filter((name) => !fs.existsSync(path.join(directory, `${name.slice(0, -4)}.info.json`))));
    if (missing.size === 0) continue;

    const knownIds = new Set();
    for (const entry of entries.filter((item) => item.isFile() && !item.name.startsWith('._') && item.name.endsWith('.info.json'))) {
      try {
        const metadata = JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8'));
        if (metadata.id) knownIds.add(String(metadata.id));
      } catch (error) {
        console.warn(`[metadata] unreadable ${target.directory}/${entry.name}: ${error.message}`);
      }
    }
    const ids = fs.readFileSync(archive, 'utf8').split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u).pop()).filter(Boolean)
      .filter((id, index, all) => !knownIds.has(id) && all.indexOf(id) === index);

    console.log(`[metadata] ${target.directory}: ${missing.size} MP4 file${missing.size === 1 ? '' : 's'} missing info JSON`);
    let queryFailed = false;
    for (const id of ids) {
      if (missing.size === 0) break;
      if (unavailableRecently(unavailable, directory, id)) {
        queryFailed = true;
        continue;
      }
      const temporary = path.join(tools.stateDirectory || tools.appDirectory, `backfill-${process.pid}-${id.replace(/[^a-zA-Z0-9_-]/gu, '_')}.json`);
      try {
        const result = run(tools.ytDlp, [
          '--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings',
          ...cookieArgs(config), '-f', videoFormat(config),
          '--ffmpeg-location', tools.ffmpeg,
          '--js-runtimes', `${tools.jsRuntime.name}:${tools.jsRuntime.command}`,
          `https://youtu.be/${id}`
        ], { cwd: directory, capture: true, quiet: true, errorLabel: 'yt-dlp' });
        const metadata = JSON.parse(result.stdout);
        if (unavailable[unavailableKey(directory, id)]) {
          delete unavailable[unavailableKey(directory, id)];
          unavailableChanged = true;
        }
        fs.writeFileSync(temporary, `${JSON.stringify(metadata)}\n`);
        const template = targetOutputFormat(config, target);
        const candidates = new Set([
          renderBackfillName(tools, temporary, template, directory, false),
          renderBackfillName(tools, temporary, template, directory, true)
        ]);
        const matches = [...candidates].filter((name) => missing.has(name));
        if (matches.length !== 1) continue;
        const video = matches[0];
        const destination = path.join(directory, `${video.slice(0, -4)}.info.json`);
        console.log(`[metadata] ${options.simulate ? 'would create' : 'create'} ${path.relative(resolveArchive(config), destination)}`);
        if (!options.simulate) fs.writeFileSync(destination, `${JSON.stringify(metadata, null, 2)}\n`);
        missing.delete(video);
      } catch (error) {
        queryFailed = true;
        if (isUnavailableError(error)) {
          unavailable[unavailableKey(directory, id)] = { checkedAt: new Date().toISOString() };
          unavailableChanged = true;
        }
        if (!error.outputDisplayed) {
          console.warn(`[download] unable to fetch metadata ${target.directory} / ${id}: ${formatProcessError(error)}`);
        }
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    }
    if (!queryFailed) {
      for (const video of missing) console.warn(`[metadata] no unambiguous archive match for ${target.directory}/${video}`);
    }
  }
  if (unavailableChanged) saveUnavailableState(tools, unavailable);
}

function repairArchivedVideos(config, tools, options) {
  if (options.skipInfoBackfill) return;
  const unavailable = loadUnavailableState(tools);
  let unavailableChanged = false;
  for (const target of config.targets || []) {
    if (target.enable === 0 || target.enabled === false) continue;
    const directory = resolveArchive(config, target.directory);
    const archive = path.join(directory, target.archive || 'archive.txt');
    if (!fs.existsSync(directory) || !fs.existsSync(archive)) continue;
    const archivedIds = fs.readFileSync(archive, 'utf8').split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u).pop()).filter(Boolean)
      .filter((id, index, all) => all.indexOf(id) === index);
    const presentIds = new Set();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('._') || !entry.name.endsWith('.info.json')) continue;
      try {
        const metadata = JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8'));
        const video = path.join(directory, `${entry.name.slice(0, -10)}.mp4`);
        if (metadata.id && fs.existsSync(video)) presentIds.add(String(metadata.id));
      } catch (error) {
        console.warn(`[metadata] unreadable ${target.directory}/${entry.name}: ${error.message}`);
      }
    }
    const missingIds = archivedIds.filter((id) => !presentIds.has(id) && !unavailableRecently(unavailable, directory, id));
    for (const id of missingIds) {
      console.log(`[download] ${options.simulate ? 'would refetch' : 'refetch'} missing video ${target.directory} / ${id}`);
      try {
        run(tools.ytDlp, [
          ...(options.simulate ? ['--simulate'] : []),
          '--match-filters', 'live_status != is_live & live_status != is_upcoming & live_status != post_live',
          '--restrict-filenames',
          '--write-info-json', ...cookieArgs(config), '--no-cache-dir',
          '--no-abort-on-error', '--no-overwrites', '--no-playlist', '-i', '-f', videoFormat(config),
          '--ffmpeg-location', tools.ffmpeg,
          '--js-runtimes', `${tools.jsRuntime.name}:${tools.jsRuntime.command}`,
          '--output', targetOutputFormat(config, target),
          ...(target.extraArgs || []), `https://youtu.be/${id}`
        ], { cwd: directory, errorLabel: 'yt-dlp' });
        if (unavailable[unavailableKey(directory, id)]) {
          delete unavailable[unavailableKey(directory, id)];
          unavailableChanged = true;
        }
      } catch (error) {
        if (isUnavailableError(error)) {
          unavailable[unavailableKey(directory, id)] = { checkedAt: new Date().toISOString() };
          unavailableChanged = true;
        }
        if (!error.outputDisplayed) {
          console.warn(`[download] unable to refetch ${target.directory} / ${id}: ${formatProcessError(error)}`);
        }
      }
    }
  }
  if (unavailableChanged) saveUnavailableState(tools, unavailable);
}

function assertWindowsSymlinks(appDirectory) {
  if (process.platform !== 'win32') return;
  const probeDirectory = path.join(appDirectory, 'symlink-test');
  const source = path.join(probeDirectory, 'source.txt');
  const link = path.join(probeDirectory, 'link.txt');
  fs.mkdirSync(probeDirectory, { recursive: true });
  fs.writeFileSync(source, 'test');
  try {
    if (fs.existsSync(link)) fs.unlinkSync(link);
    fs.symlinkSync(source, link, 'file');
    fs.unlinkSync(link);
    fs.unlinkSync(source);
    fs.rmdirSync(probeDirectory);
  } catch (error) {
    throw new Error([
      'Windows symbolic links are not enabled for this user.',
      'Enable Developer Mode: Settings > System > For developers > Developer Mode.',
      'On older Windows: Settings > Update & Security > For developers.',
      'Then close this terminal, open a new one, and run the archiver again.',
      `Windows reported: ${error.message}`
    ].join(os.EOL));
  }
}

function applyLinkRules(config, appDirectory, options) {
  const errors = [];
  if (!config.linkRules || config.linkRules.length === 0) return errors;
  assertWindowsSymlinks(appDirectory);
  for (const rule of config.linkRules) {
    const archiveDirectory = resolveArchive(config);
    const sourceDirectory = resolveArchive(config, rule.sourceDirectory);
    if (!fs.existsSync(sourceDirectory)) continue;
    const pattern = new RegExp(rule.pattern, rule.flags || 'u');
    for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!(rule.extensions || []).some((extension) => entry.name.endsWith(extension))) continue;
      const relativeSource = path.relative(archiveDirectory, path.join(sourceDirectory, entry.name)).split(path.sep).join('/');
      if (!pattern.test(relativeSource)) continue;
      pattern.lastIndex = 0;
      let relativeTarget = relativeSource.replace(pattern, rule.replacement);
      for (const transform of rule.transforms || []) {
        relativeTarget = relativeTarget.replace(new RegExp(transform.pattern, transform.flags || 'g'), transform.replacement);
      }
      const source = path.resolve(archiveDirectory, relativeSource);
      const target = path.resolve(archiveDirectory, relativeTarget);
      if (fs.existsSync(target)) continue;
      console.log(`[link] ${relativeTarget} -> ${relativeSource}`);
      if (!options.simulate) {
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.symlinkSync(source, target, 'file');
        } catch (error) {
          errors.push(`link ${relativeTarget}: ${error.message}`);
        }
      }
    }
  }
  return errors;
}

function collectTranscripts(config, options) {
  const errors = [];
  const destination = resolveArchive(config, config.transcriptDestination || 'Transcripts-YouTube');
  if (!options.simulate) fs.mkdirSync(destination, { recursive: true });
  for (const relativeDirectory of config.transcriptDirectories || []) {
    const directory = resolveArchive(config, relativeDirectory);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!entry.name.endsWith('.en.srt.json')) continue;
      try {
        const source = fs.realpathSync(path.join(directory, entry.name));
        const target = path.join(destination, entry.name);
        if (!fs.existsSync(target)) {
          console.log(`[transcript] copy ${source} -> ${target}`);
          if (!options.simulate) {
            fs.copyFileSync(source, target);
          }
        }
      } catch (error) {
        errors.push(`transcript copy ${entry.name}: ${error.message}`);
      }
    }
  }
  return errors;
}

function runPostSteps(config, options) {
  const errors = [];
  for (const step of config.postSteps || []) {
    if (step.enabled === false) continue;
    if (step.platforms && !step.platforms.includes(platformKey())) continue;
    const executable = process.execPath;
    const isSelf = step.command === '${self}';
    const archiveDirectory = resolveArchive(config);
    const replacements = { '${self}': executable, '${executable}': executable, '${configDir}': config.configDirectory, '${archiveDir}': archiveDirectory };
    const replace = (value) => (replacements[value] || value)
      .replace(/\$\{configDir\}/g, config.configDirectory)
      .replace(/\$\{archiveDir\}/g, archiveDirectory);
    const args = (step.args || []).map(replace);
    if (isSelf && !process.pkg) args.unshift(options.entrypoint);
    try {
      const result = run(replace(step.command), args, {
        cwd: resolveFromConfig(config, step.cwd || '.'), simulate: options.simulate,
        allowFailure: step.continueOnError === true
      });
      if (result.status !== 0 && step.continueOnError !== true) {
        errors.push(null);
      }
    } catch (error) {
      errors.push(error.outputDisplayed ? null : `post-step ${step.command}: ${formatProcessError(error)}`);
    }
  }
  return errors;
}

module.exports = {
  applyLinkRules, assertCookieAccess, backfillInfo, collectTranscripts, downloadTarget, outputFormat,
  repairArchivedVideos, runPostSteps, videoFormat
};
