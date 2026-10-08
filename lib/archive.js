'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { errorText, formatProcessError, run } = require('./process');
const { resolveArchive, resolveFromConfig } = require('./config');
const { canonicalSrtJson, convertSrtFile, isSrtCompanion, writeSrtJson } = require('./subtitles');
const { platformKey } = require('./tools');
const { targetProfile } = require('./migrate');
const {
  BACKENDS: TRANSCRIPT_BACKENDS, DEFAULT_BACKEND, generate: generateTranscript, NoTranscriptTextError,
  transcriptOutput
} = require('./transcript');
const {
  generateTranscriptMarkdown, markdownOutput, renderTranscriptMarkdown
} = require('./transcript-markdown');

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

function youtubeIdFromFilename(filename) {
  const stem = path.basename(filename, path.extname(filename));
  const match = stem.match(/(?:\[([A-Za-z0-9_-]{11})\]|-([A-Za-z0-9_-]{11}))$/u);
  return match ? (match[1] || match[2]) : null;
}

function processErrorDetail(error) {
  return formatProcessError(error).replace(/^ERROR:\s*/u, '');
}

function unavailableRecently(state, directory, id) {
  const entry = state[unavailableKey(directory, id)];
  return entry && Date.now() - Date.parse(entry.checkedAt) < UNAVAILABLE_RETRY_MS;
}

function isUnavailableError(error) {
  return /(?:video unavailable|private video|this video is unavailable)/iu.test(error.stderr || error.message);
}

function isRateLimitError(error) {
  return /(?:HTTP Error 429|Too Many Requests)/iu.test(`${error.stderr || ''}\n${error.message || ''}`);
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

function subtitleClientArgs(config) {
  const browser = config.cookies && config.cookies[platformKey()];
  return [
    '--extractor-args', 'youtube:player_client=web_embedded',
    ...(browser ? ['--impersonate', browser] : [])
  ];
}

function requestedSubtitleLanguage(config, target) {
  return target.subtitleLanguage || config.subtitleLanguage || 'en';
}

function metadataForId(directory, id) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('._') || !entry.name.endsWith('.info.json')) continue;
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8'));
      if (String(metadata.id || '') === id) return metadata;
    } catch (error) {
      // Metadata validation reports malformed files; subtitle fallback can continue without it.
    }
  }
  return null;
}

function isManualYoutubeSubtitle(srt, metadata) {
  if (!srt || !metadata || !metadata.subtitles) return false;
  const match = path.basename(srt).match(/\.([^.]+)\.srt$/u);
  return Boolean(match && Object.prototype.hasOwnProperty.call(metadata.subtitles, match[1]));
}

function videoForId(directory, id) {
  const embedded = findMatchingFile(directory, (name) =>
    name.toLowerCase().endsWith('.mp4') && youtubeIdFromFilename(name) === id);
  if (embedded) return embedded;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('._') || !entry.name.endsWith('.info.json')) continue;
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8'));
      const video = path.join(directory, `${entry.name.slice(0, -10)}.mp4`);
      if (String(metadata.id || '') === id && fs.existsSync(video)) return video;
    } catch (error) {
      // Metadata validation reports malformed files separately.
    }
  }
  return null;
}

function subtitleForVideo(video) {
  if (!video) return null;
  const directory = path.dirname(video);
  const stem = path.basename(video, path.extname(video));
  return findMatchingFile(directory, (name) => isSrtCompanion(name, stem));
}

function generatedSubtitleForVideo(video, backend = DEFAULT_BACKEND) {
  if (!video) return null;
  const directory = path.dirname(video);
  const stem = path.basename(video, path.extname(video));
  const preferred = path.join(directory, `${stem}.${backend}.srt`);
  if (fs.existsSync(preferred)) return preferred;
  for (const name of Object.keys(TRANSCRIPT_BACKENDS)) {
    const candidate = path.join(directory, `${stem}.${name}.srt`);
    if (fs.existsSync(candidate)) return candidate;
  }
  const legacy = path.join(directory, `${stem}.srt`);
  return fs.existsSync(legacy) ? legacy : null;
}

function emptyGeneratedTranscriptForVideo(video, backend = DEFAULT_BACKEND) {
  if (!video) return null;
  const marker = `${transcriptOutput(video, backend)}.json`;
  if (!fs.existsSync(marker)) return null;
  try {
    const items = JSON.parse(fs.readFileSync(marker, 'utf8'));
    return Array.isArray(items) && items.length === 0 ? marker : null;
  } catch (error) {
    return null;
  }
}

function transcriptGenerationSettings(config, target) {
  const global = config.transcriptGeneration || {};
  const local = target.transcriptGeneration || {};
  return { enabled: true, backend: DEFAULT_BACKEND, language: 'en', chunkSeconds: 20, ...global, ...local };
}

function transcriptTemplate(config) {
  const configured = config.transcriptTemplate;
  const candidates = [
    configured && resolveFromConfig(config, configured),
    path.join(config.configDirectory, 'template-transcript.md'),
    path.join(path.dirname(process.execPath), 'template-transcript.md'),
    path.resolve(__dirname, '..', 'template-transcript.md')
  ].filter(Boolean);
  return candidates.find((filename) => fs.existsSync(filename)) || null;
}

function selectedTranscriptSource(video, youtubeSrt, metadata, backend = DEFAULT_BACKEND) {
  return (isManualYoutubeSubtitle(youtubeSrt, metadata) && youtubeSrt)
    || generatedSubtitleForVideo(video, backend) || youtubeSrt;
}

function subtitleAttempts(config, target, metadata = null) {
  const requested = requestedSubtitleLanguage(config, target);
  if (requested !== 'en') return [
    { label: `manual ${requested}`, language: requested, automatic: false },
    { label: `automatic ${requested}`, language: requested, automatic: true }
  ];

  let attempts = [
    { label: 'manual English', language: 'en', automatic: false },
    { label: 'automatic English', language: 'en', automatic: true },
    { label: 'original automatic English', language: 'en-orig', automatic: true },
    { label: 'manual US English', language: 'en-US', automatic: false },
    { label: 'automatic US English', language: 'en-US', automatic: true },
    { label: 'manual British English', language: 'en-GB', automatic: false },
    { label: 'automatic British English', language: 'en-GB', automatic: true }
  ];
  if (metadata) {
    attempts = attempts.filter((attempt) => {
      const available = attempt.automatic ? metadata.automatic_captions : metadata.subtitles;
      return Boolean(available && Object.prototype.hasOwnProperty.call(available, attempt.language));
    });
  }
  const known = new Set(attempts.map((attempt) => `${attempt.automatic}:${attempt.language}`));
  const addAvailable = (languages, automatic) => {
    for (const language of Object.keys(languages || {})) {
      if (!/^en(?:[-_].+)?$/iu.test(language) || language === 'live_chat') continue;
      const key = `${automatic}:${language}`;
      if (known.has(key)) continue;
      known.add(key);
      attempts.push({ label: `${automatic ? 'automatic' : 'manual'} English fallback ${language}`, language, automatic });
    }
  };
  addAvailable(metadata && metadata.subtitles, false);
  addAvailable(metadata && metadata.automatic_captions, true);
  return attempts;
}

// Keep format, authentication, and runtime selection identical for normal
// downloads, repairs, and quality migrations. Callers add only operation-
// specific playlist, output, archive, and simulation arguments.
function videoCoreArgs(config, tools, target = {}, options = {}) {
  return [
    '--match-filters', 'live_status != is_live & live_status != is_upcoming & live_status != post_live',
    '--restrict-filenames', ...(options.writeInfo === false ? [] : ['--write-info-json']), ...cookieArgs(config),
    '--no-cache-dir', '--no-abort-on-error', '-i', '-f', videoFormat(config),
    '--ffmpeg-location', tools.ffmpeg,
    '--js-runtimes', `${tools.jsRuntime.name}:${tools.jsRuntime.command}`
  ];
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
    '--sleep-requests', '2',
    '--min-sleep-interval', '5', '--max-sleep-interval', '15',
    '--sleep-subtitles', '3', ...videoCoreArgs(config, tools, target),
    '--no-overwrites', '--yes-playlist',
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
  const archiveExists = fs.existsSync(archive);
  if (!archiveExists) {
    if (!options.simulate) console.warn(`[transcript] archive not found: ${archive}`);
  }
  const ids = subtitleIds(directory, archive);
  const archivedIds = new Set(archiveExists
    ? fs.readFileSync(archive, 'utf8').split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u).pop()).filter(Boolean)
    : []);
  const videosHandledById = new Set();
  for (const id of ids) {
    const localVideo = videoForId(directory, id);
    if (localVideo) videosHandledById.add(path.resolve(localVideo));
    const metadata = metadataForId(directory, id);
    let srt = findMatchingFile(directory, (name) => name.includes(id) && name.endsWith('.srt'))
      || subtitleForVideo(localVideo)
      || generatedSubtitleForVideo(localVideo, transcriptGenerationSettings(config, target).backend);
    if (!srt) {
      console.log(`[transcript] No subtitles for ${id} yet`);
      const attempts = subtitleAttempts(config, target, metadata);
      for (const attempt of attempts) {
        console.log(`[download] try ${attempt.label} (${attempt.language}) for ${id}`);
        try {
          run(tools.ytDlp, [
            ...(options.simulate ? ['--simulate'] : []),
            '--restrict-filenames', attempt.automatic ? '--write-auto-sub' : '--write-subs', ...subtitleClientArgs(config),
            '--socket-timeout', '15',
            '--sleep-requests', '2',
            '--min-sleep-interval', '5', '--max-sleep-interval', '15',
            '--sleep-subtitles', '3',
            '--sub-lang', attempt.language,
            '--convert-subs', 'srt', '--skip-download', '--no-overwrites', ...cookieArgs(config),
            '--ffmpeg-location', tools.ffmpeg, '--output', targetOutputFormat(config, target, true),
            '--js-runtimes', `${tools.jsRuntime.name}:${tools.jsRuntime.command}`,
            `https://youtu.be/${id}`
          ], { cwd: directory, errorLabel: 'yt-dlp', captureStderr: true });
        } catch (error) {
          const reason = isRateLimitError(error) ? 'rate limited' : 'failed';
          console.warn(`[download] ${attempt.label} ${reason}; trying next fallback`);
        }
        srt = findMatchingFile(directory, (name) => name.includes(id) && name.endsWith('.srt'));
        if (srt) {
          console.log(`[transcript] found ${attempt.label} for ${id}`);
          break;
        }
        console.log(`[transcript] ${attempt.label} not available for ${id}`);
      }
    }
    if (srt && !archivedIds.has(id)) {
      const standaloneVideo = findMatchingFile(directory, (name) =>
        name.toLowerCase().endsWith('.mp4') && youtubeIdFromFilename(name) === id);
      if (standaloneVideo) {
        const languageSuffix = path.basename(srt).match(/(\.[^.]+\.srt)$/u);
        if (languageSuffix) {
          const exactSrt = path.join(directory,
            `${path.basename(standaloneVideo, path.extname(standaloneVideo))}${languageSuffix[1]}`);
          if (srt !== exactSrt && !fs.existsSync(exactSrt)) {
            console.log(`[transcript] rename ${path.basename(srt)} -> ${path.basename(exactSrt)}`);
            if (!options.simulate) {
              fs.renameSync(srt, exactSrt);
              if (fs.existsSync(`${srt}.json`) && !fs.existsSync(`${exactSrt}.json`)) {
                fs.renameSync(`${srt}.json`, `${exactSrt}.json`);
              }
            }
            srt = exactSrt;
          }
        }
      }
    }
    if (!srt) {
      const settings = transcriptGenerationSettings(config, target);
      const video = localVideo;
      const emptyTranscript = emptyGeneratedTranscriptForVideo(video, settings.backend);
      if (emptyTranscript) {
        console.warn(`[transcript] no speech previously detected for ${id}; keeping ${path.basename(emptyTranscript)}`);
        continue;
      }
      if (settings.enabled !== false && video) {
        console.log(`[transcript] YouTube subtitles unavailable for ${id}; generating locally from ${path.basename(video)}`);
        try {
          srt = (options.generateTranscript || generateTranscript)({
            backend: settings.backend,
            model: settings.model || null,
            language: settings.language,
            chunkSeconds: Number(settings.chunkSeconds) || 20,
            force: false,
            simulate: options.simulate,
            video,
            cacheDirectory: resolveFromConfig(config, settings.applicationDirectory || '.generate-transcript'),
            ffmpeg: tools.ffmpeg,
            ffprobe: tools.ffprobe
          });
        } catch (error) {
          if (error instanceof NoTranscriptTextError || error.code === 'NO_TRANSCRIPT_TEXT') {
            const marker = `${transcriptOutput(video, settings.backend)}.json`;
            if (!fs.existsSync(marker)) fs.writeFileSync(marker, '[]\n', { flag: 'wx' });
            console.warn(`[transcript] no speech detected for ${id}; wrote ${path.basename(marker)}`);
            continue;
          } else {
            errors.push(`${target.directory}: local transcript ${id}: ${error.message}`);
          }
        }
      }
      if (!srt || (!options.simulate && !fs.existsSync(srt))) {
        if (!options.simulate) console.warn(`[transcript] unable to get subtitles for ${id}`);
        continue;
      }
    }
    try {
      let json;
      if (localVideo) {
        const settings = transcriptGenerationSettings(config, target);
        const source = selectedTranscriptSource(localVideo, srt, metadata, settings.backend);
        json = canonicalSrtJson(localVideo, source, id);
        if (!fs.existsSync(json)) {
          console.log(`[transcript] create ${path.basename(json)} <- ${path.basename(source)}`);
          if (!options.simulate) writeSrtJson(source, json);
        }
      } else if (!fs.existsSync(`${srt}.json`)) {
        json = `${srt}.json`;
        console.log(`[transcript] generate ${path.basename(json)}`);
        if (!options.simulate) convertSrtFile(srt);
      } else {
        json = `${srt}.json`;
      }
      if (json) {
        const template = transcriptTemplate(config);
        if (!template) throw new Error('Unable to find template-transcript.md.');
        const markdown = markdownOutput(json);
        let changed = !fs.existsSync(markdown);
        if (fs.existsSync(json)) {
          const rendered = renderTranscriptMarkdown(json, template);
          changed = changed || fs.readFileSync(markdown, 'utf8') !== rendered.content;
        }
        if (changed) {
          console.log(`[transcript] markdown ${path.basename(markdown)}`);
          if (!options.simulate && fs.existsSync(json)) generateTranscriptMarkdown(json, template);
        }
      }
    } catch (error) {
      errors.push(`${target.directory}: subtitle JSON ${id}: ${error.message}`);
    }
  }

  const settings = transcriptGenerationSettings(config, target);
  if (settings.enabled !== false) {
    const unassociatedVideos = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('._') && entry.name.toLowerCase().endsWith('.mp4'))
      .map((entry) => path.join(directory, entry.name))
      .filter((video) => !videosHandledById.has(path.resolve(video)));
    for (const video of unassociatedVideos) {
      if (subtitleForVideo(video) || generatedSubtitleForVideo(video, settings.backend)) continue;
      const emptyTranscript = emptyGeneratedTranscriptForVideo(video, settings.backend);
      if (emptyTranscript) {
        console.warn(`[transcript] no speech previously detected for ${path.basename(video)}; keeping ${path.basename(emptyTranscript)}`);
        continue;
      }
      console.log(`[transcript] no YouTube ID for ${path.basename(video)}; generating locally`);
      let srt;
      try {
        srt = (options.generateTranscript || generateTranscript)({
          backend: settings.backend,
          model: settings.model || null,
          language: settings.language,
          chunkSeconds: Number(settings.chunkSeconds) || 20,
          force: false,
          simulate: options.simulate,
          video,
          cacheDirectory: resolveFromConfig(config, settings.applicationDirectory || '.generate-transcript'),
          ffmpeg: tools.ffmpeg,
          ffprobe: tools.ffprobe
        });
      } catch (error) {
        if (error instanceof NoTranscriptTextError || error.code === 'NO_TRANSCRIPT_TEXT') {
          const marker = `${transcriptOutput(video, settings.backend)}.json`;
          if (!fs.existsSync(marker)) fs.writeFileSync(marker, '[]\n', { flag: 'wx' });
          console.warn(`[transcript] no speech detected for ${path.basename(video)}; wrote ${path.basename(marker)}`);
        } else {
          errors.push(`${target.directory}: local transcript ${path.basename(video)}: ${error.message}`);
        }
        continue;
      }
      if (!srt || (!options.simulate && !fs.existsSync(srt))) continue;
      try {
        const json = canonicalSrtJson(video, srt);
        if (!fs.existsSync(json)) {
          console.log(`[transcript] create ${path.basename(json)} <- ${path.basename(srt)}`);
          if (!options.simulate) writeSrtJson(srt, json);
        }
        const template = transcriptTemplate(config);
        if (!template) throw new Error('Unable to find template-transcript.md.');
        const markdown = markdownOutput(json);
        let changed = !fs.existsSync(markdown);
        if (fs.existsSync(json)) {
          const rendered = renderTranscriptMarkdown(json, template);
          changed = changed || fs.readFileSync(markdown, 'utf8') !== rendered.content;
        }
        if (changed) {
          console.log(`[transcript] markdown ${path.basename(markdown)}`);
          if (!options.simulate && fs.existsSync(json)) generateTranscriptMarkdown(json, template);
        }
      } catch (error) {
        errors.push(`${target.directory}: subtitle JSON ${path.basename(video)}: ${error.message}`);
      }
    }
  }
  return errors;
}

function subtitleIds(directory, archive) {
  const ids = fs.existsSync(archive)
    ? fs.readFileSync(archive, 'utf8').split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u).pop()).filter(Boolean)
    : [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('._')) continue;
    if (entry.name.toLowerCase().endsWith('.mp4')) {
      const id = youtubeIdFromFilename(entry.name);
      if (id) ids.push(id);
    } else if (entry.name.endsWith('.info.json')) {
      try {
        const metadata = JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8'));
        const video = path.join(directory, `${entry.name.slice(0, -10)}.mp4`);
        if (metadata._type !== 'playlist' && metadata.id && fs.existsSync(video)) ids.push(String(metadata.id));
      } catch (error) {
        // Metadata readability is reported by the metadata pass.
      }
    }
  }
  return ids.filter((id, index, all) => all.indexOf(id) === index);
}

function findMatchingFile(directory, predicate) {
  // Archive companions belong beside their MP4. A subtitle in a legacy or
  // quality subdirectory must not suppress creation in the active target.
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.startsWith('._') && predicate(entry.name)) {
      return path.join(directory, entry.name);
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
    const embeddedVideos = new Map();
    for (const video of missing) {
      const id = youtubeIdFromFilename(video);
      if (!id) continue;
      if (!embeddedVideos.has(id)) embeddedVideos.set(id, []);
      embeddedVideos.get(id).push(video);
    }
    const archivedIds = fs.readFileSync(archive, 'utf8').split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u).pop()).filter(Boolean)
      .filter((id, index, all) => all.indexOf(id) === index);
    const ids = [...embeddedVideos.keys(), ...archivedIds]
      .filter((id, index, all) => !knownIds.has(id) && all.indexOf(id) === index);

    console.log(`[metadata] ${target.directory}: ${missing.size} MP4 file${missing.size === 1 ? '' : 's'} missing info JSON`);
    let queryFailed = false;
    for (const [idIndex, id] of ids.entries()) {
      if (missing.size === 0) break;
      if (unavailableRecently(unavailable, directory, id)) {
        const checkedAt = unavailable[unavailableKey(directory, id)].checkedAt;
        const retryAt = new Date(Date.parse(checkedAt) + UNAVAILABLE_RETRY_MS).toISOString();
        console.log(`[metadata] skip unavailable ${target.directory} / ${id} (checked ${checkedAt}; retry after ${retryAt}; ${idIndex + 1}/${ids.length}; ${missing.size} unresolved)`);
        queryFailed = true;
        continue;
      }
      console.log(`[metadata] check ${target.directory} / ${id} (${idIndex + 1}/${ids.length}; ${missing.size} unresolved)`);
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
        if (String(metadata.id) !== id) throw new Error(`YouTube returned metadata ID ${metadata.id} for requested ID ${id}`);
        if (unavailable[unavailableKey(directory, id)]) {
          delete unavailable[unavailableKey(directory, id)];
          unavailableChanged = true;
          saveUnavailableState(tools, unavailable);
        }
        fs.writeFileSync(temporary, `${JSON.stringify(metadata)}\n`);
        const embeddedMatches = (embeddedVideos.get(id) || []).filter((name) => missing.has(name));
        let matches = embeddedMatches;
        if (matches.length === 0) {
          const template = targetOutputFormat(config, target);
          const candidates = new Set([
            renderBackfillName(tools, temporary, template, directory, false),
            renderBackfillName(tools, temporary, template, directory, true)
          ]);
          matches = [...candidates].filter((name) => missing.has(name));
        }
        if (matches.length === 0) {
          console.log(`[metadata] not found ${target.directory} / ${id}: no matching MP4`);
          continue;
        }
        if (matches.length > 1) {
          console.warn(`[metadata] ambiguous ${target.directory} / ${id}: ${matches.join(', ')}`);
          continue;
        }
        const video = matches[0];
        console.log(`[metadata] found ${target.directory} / ${id} -> ${video}`);
        const destination = path.join(directory, `${video.slice(0, -4)}.info.json`);
        console.log(`[download] ${options.simulate ? 'would create' : 'create'} ${path.relative(resolveArchive(config), destination)}`);
        if (!options.simulate) fs.writeFileSync(destination, `${JSON.stringify(metadata, null, 2)}\n`);
        missing.delete(video);
      } catch (error) {
        queryFailed = true;
        if (isUnavailableError(error)) {
          unavailable[unavailableKey(directory, id)] = { checkedAt: new Date().toISOString() };
          unavailableChanged = true;
          saveUnavailableState(tools, unavailable);
        }
        if (!error.outputDisplayed) {
          console.error(errorText(`[ERROR] unable to fetch metadata ${target.directory} / ${id}: ${processErrorDetail(error)}`));
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
          ...videoCoreArgs(config, tools, target),
          '--no-overwrites', '--no-playlist',
          '--output', targetOutputFormat(config, target),
          ...(target.extraArgs || []), `https://youtu.be/${id}`
        ], { cwd: directory, errorLabel: 'yt-dlp' });
        if (unavailable[unavailableKey(directory, id)]) {
          delete unavailable[unavailableKey(directory, id)];
          unavailableChanged = true;
          saveUnavailableState(tools, unavailable);
        }
      } catch (error) {
        if (isUnavailableError(error)) {
          unavailable[unavailableKey(directory, id)] = { checkedAt: new Date().toISOString() };
          unavailableChanged = true;
          saveUnavailableState(tools, unavailable);
        }
        if (!error.outputDisplayed) {
          console.error(errorText(`[ERROR] unable to refetch ${target.directory} / ${id}: ${processErrorDetail(error)}`));
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

function isMacNetworkSymlinkPlaceholder(filename) {
  let descriptor;
  try {
    if (!fs.statSync(filename).isFile()) return false;
    descriptor = fs.openSync(filename, 'r');
    const header = Buffer.alloc(5);
    return fs.readSync(descriptor, header, 0, header.length, 0) === header.length
      && header.toString('ascii') === 'XSym\n';
  } catch (error) {
    return false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function decodeRestrictedLinkSource(relativeSource) {
  const slash = relativeSource.lastIndexOf('/');
  const directory = slash === -1 ? '' : relativeSource.slice(0, slash + 1);
  const filename = relativeSource.slice(slash + 1);
  const companion = filename.match(/(-[A-Za-z0-9_-]{11}\.[^.]+\.(?:srt(?:\.json)?|md)|\.info\.json)$/u);
  const suffix = companion ? companion[1] : path.extname(filename);
  let title = filename.slice(0, -suffix.length);
  if (!title.includes(':') && !title.includes('：')) title = title.replace(/_/gu, ' ');
  return `${directory}${title}${suffix}`;
}

function applyLinkRules(config, appDirectory, options) {
  const errors = [];
  if (!config.linkRules || config.linkRules.length === 0) return errors;
  assertWindowsSymlinks(appDirectory);
  const matchedSources = new Set();
  for (const rule of config.linkRules) {
    const archiveDirectory = resolveArchive(config);
    const sourceDirectory = resolveArchive(config, rule.sourceDirectory);
    if (!fs.existsSync(sourceDirectory)) continue;
    const pattern = new RegExp(rule.pattern, rule.flags || 'u');
    for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('._')) continue;
      if (!(rule.extensions || []).some((extension) => entry.name.endsWith(extension))) continue;
      const relativeSource = path.relative(archiveDirectory, path.join(sourceDirectory, entry.name)).split(path.sep).join('/');
      if (matchedSources.has(relativeSource)) continue;
      const source = path.resolve(archiveDirectory, relativeSource);
      const matchSource = rule.decodeRestrictedTitle ? decodeRestrictedLinkSource(relativeSource) : relativeSource;
      if (!pattern.test(matchSource)) continue;
      pattern.lastIndex = 0;
      matchedSources.add(relativeSource);
      let relativeTarget = matchSource.replace(pattern, rule.replacement);
      for (const transform of rule.transforms || []) {
        relativeTarget = relativeTarget.replace(new RegExp(transform.pattern, transform.flags || 'g'), transform.replacement);
      }
      const target = path.resolve(archiveDirectory, relativeTarget);
      const placeholder = fs.existsSync(target) && isMacNetworkSymlinkPlaceholder(target);
      if (fs.existsSync(target) && !placeholder) continue;
      console.log(`[link] ${relativeSource} -> ${relativeTarget}${placeholder ? ' (replace network placeholder)' : ''}`);
      if (!options.simulate) {
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (placeholder) fs.unlinkSync(target);
          fs.symlinkSync(fs.realpathSync(source), target, 'file');
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
      if (!isTranscriptJsonName(entry.name)) continue;
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

function isTranscriptJsonName(name) {
  return !name.startsWith('._') && name.endsWith('.srt.json');
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
    const useShell = step.args === undefined;
    const args = (step.args || []).map(replace);
    if (isSelf && !process.pkg) args.unshift(options.entrypoint);
    const command = replace(step.command);
    try {
      const result = run(command, args, {
        cwd: resolveFromConfig(config, step.cwd || '.'), simulate: options.simulate,
        allowFailure: step.continueOnError === true, shell: useShell
      });
      if (result.status !== 0 && step.continueOnError !== true) {
        errors.push(null);
      }
    } catch (error) {
      errors.push(error.outputDisplayed ? null : `post-step ${step.name || step.command}: ${formatProcessError(error)}`);
    }
  }
  return errors;
}

module.exports = {
  applyLinkRules, assertCookieAccess, backfillInfo, collectTranscripts, downloadTarget, outputFormat,
  repairArchivedVideos, runPostSteps, videoCoreArgs, videoFormat, youtubeIdFromFilename,
  _test: {
    emptyGeneratedTranscriptForVideo, fetchSubtitles, findMatchingFile, generatedSubtitleForVideo,
    decodeRestrictedLinkSource, isMacNetworkSymlinkPlaceholder, isManualYoutubeSubtitle, isRateLimitError, isTranscriptJsonName, selectedTranscriptSource,
    subtitleAttempts, subtitleClientArgs,
    subtitleForVideo, subtitleIds, transcriptGenerationSettings, transcriptTemplate, videoForId, youtubeIdFromFilename
  }
};
