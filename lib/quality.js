'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { formatProcessError, run } = require('./process');
const { resolveArchive } = require('./config');
const { videoCoreArgs } = require('./archive');

function enabledTargets(config) {
  return (config.targets || []).filter((target) => target.enable !== 0 && target.enabled !== false);
}

function safeTargetPath(config, target) {
  const archiveRoot = resolveArchive(config);
  const directory = resolveArchive(config, target.directory);
  const relative = path.relative(archiveRoot, directory);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  if (!relative) return '_archive-root';
  return path.join('_external', crypto.createHash('sha256').update(directory).digest('hex').slice(0, 16));
}

function backupDirectory(config, tools, target) {
  return path.join(tools.stateDirectory, 'backups', safeTargetPath(config, target));
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function writeJsonAtomic(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  const descriptor = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filename);
}

function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filename, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function copyVerified(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  const descriptor = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  if (fs.statSync(source).size !== fs.statSync(temporary).size || hashFile(source) !== hashFile(temporary)) {
    fs.unlinkSync(temporary);
    throw new Error(`backup verification failed for ${source}`);
  }
  if (fs.existsSync(destination)) {
    fs.unlinkSync(temporary);
    throw new Error(`refusing to overwrite existing file: ${destination}`);
  }
  fs.renameSync(temporary, destination);
}

function probeVideo(filename) {
  const result = run('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename
  ], { capture: true, quiet: true, errorLabel: 'ffprobe' });
  const data = JSON.parse(result.stdout);
  const video = (data.streams || []).find((stream) => stream.codec_type === 'video');
  const audio = (data.streams || []).find((stream) => stream.codec_type === 'audio');
  if (!video || !audio) throw new Error('MP4 must contain both video and audio streams');
  return {
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    fps: parseRate(video.avg_frame_rate || video.r_frame_rate),
    videoCodec: String(video.codec_name || 'unknown').toLowerCase(),
    videoBitrate: Number(video.bit_rate) || 0,
    audioCodec: String(audio.codec_name || 'unknown').toLowerCase(),
    audioBitrate: Number(audio.bit_rate) || 0,
    duration: Number(data.format && data.format.duration) || 0,
    format: String(data.format && data.format.format_name || '')
  };
}

function parseRate(value) {
  if (!value) return 0;
  const [numerator, denominator = '1'] = String(value).split('/').map(Number);
  return denominator ? numerator / denominator : 0;
}

function selectedStreams(metadata) {
  const requested = metadata.requested_downloads || metadata.requested_formats || [metadata];
  const streams = requested.flatMap((item) => item.requested_formats || [item]);
  const video = streams.find((stream) => stream.vcodec && stream.vcodec !== 'none') || metadata;
  const audio = streams.find((stream) => stream.acodec && stream.acodec !== 'none') || metadata;
  return {
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    fps: Number(video.fps) || 0,
    videoCodec: normalizeCodec(video.vcodec),
    videoBitrate: (Number(video.vbr) || Number(video.tbr) || 0) * 1000,
    audioCodec: normalizeCodec(audio.acodec),
    audioBitrate: (Number(audio.abr) || Number(audio.tbr) || 0) * 1000,
    duration: Number(metadata.duration) || 0,
    ext: String(metadata.ext || video.ext || '')
  };
}

function normalizeCodec(codec) {
  const value = String(codec || 'unknown').toLowerCase();
  if (/^(?:avc1|avc|h264)/u.test(value)) return 'h264';
  if (/^(?:hev1|hvc1|hevc|h265)/u.test(value)) return 'hevc';
  if (/^(?:av01|av1)/u.test(value)) return 'av1';
  if (/^(?:vp09|vp9)/u.test(value)) return 'vp9';
  if (/^(?:mp4a|aac)/u.test(value)) return 'aac';
  if (/opus/u.test(value)) return 'opus';
  return value;
}

function codecRank(codec) {
  return ({ h264: 0, hevc: 1, av1: 2, vp9: 3 })[normalizeCodec(codec)] ?? 10;
}

function compareQuality(existing, candidate) {
  if (candidate.height > existing.height) return `resolution ${existing.width}x${existing.height} -> ${candidate.width}x${candidate.height}`;
  if (candidate.height < existing.height) return null;
  if (candidate.width > existing.width) return `resolution ${existing.width}x${existing.height} -> ${candidate.width}x${candidate.height}`;
  if (candidate.width < existing.width) return null;
  if (codecRank(candidate.videoCodec) < codecRank(existing.videoCodec)) {
    return `video codec ${existing.videoCodec} -> ${candidate.videoCodec}`;
  }
  if (normalizeCodec(candidate.videoCodec) !== normalizeCodec(existing.videoCodec)) return null;
  if (candidate.fps > existing.fps + 1) return `frame rate ${existing.fps.toFixed(2)} -> ${candidate.fps.toFixed(2)} fps`;
  if (candidate.videoBitrate > existing.videoBitrate * 1.15 && existing.videoBitrate > 0) return 'higher video bitrate';
  if (normalizeCodec(candidate.audioCodec) === 'aac' && normalizeCodec(existing.audioCodec) !== 'aac') {
    return `audio codec ${existing.audioCodec} -> aac`;
  }
  if (candidate.audioBitrate > existing.audioBitrate * 1.15 && existing.audioBitrate > 0) return 'higher audio bitrate';
  return null;
}

function queryCandidate(config, tools, target, id) {
  const result = run(tools.ytDlp, [
    '--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings',
    ...videoCoreArgs(config, tools, target, { writeInfo: false }),
    ...(target.extraArgs || []), `https://youtu.be/${id}`
  ], { cwd: resolveArchive(config, target.directory), capture: true, quiet: true, errorLabel: 'yt-dlp' });
  const metadata = JSON.parse(result.stdout);
  return { metadata, quality: selectedStreams(metadata) };
}

function pairsForTarget(config, target) {
  const directory = resolveArchive(config, target.directory);
  if (!fs.existsSync(directory)) return [];
  const pairs = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('._') || !entry.name.endsWith('.info.json')) continue;
    const info = path.join(directory, entry.name);
    const video = path.join(directory, `${entry.name.slice(0, -10)}.mp4`);
    if (!fs.existsSync(video)) continue;
    try {
      const metadata = readJson(info);
      if (metadata.id) pairs.push({ id: String(metadata.id), video, info });
    } catch (error) {
      console.warn(`[quality] skip unreadable metadata ${path.relative(resolveArchive(config), info)}: ${error.message}`);
    }
  }
  return pairs;
}

function pinsFile(tools) {
  return path.join(tools.stateDirectory, 'quality-reverted.json');
}

function loadPins(tools) {
  try { return fs.existsSync(pinsFile(tools)) ? readJson(pinsFile(tools)) : {}; } catch (error) { return {}; }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/gu, '-');
}

function uniqueStamp() {
  return `${timestamp()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}

function askBackupConflict(relative, promptState) {
  if (promptState.all) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  fs.writeSync(process.stdout.fd, `Backup already exists: ${relative}\nOverwrite active restore point? [y]es / [n]o / [a]ll `);
  const buffer = Buffer.alloc(32);
  const count = fs.readSync(process.stdin.fd, buffer, 0, buffer.length, null);
  const answer = buffer.toString('utf8', 0, count).trim().toLowerCase();
  if (answer === 'a' || answer === 'all') promptState.all = true;
  return promptState.all || answer === 'y' || answer === 'yes';
}

function moveActiveBackupToHistory(root, files) {
  const history = path.join(root, '.history', uniqueStamp());
  fs.mkdirSync(history, { recursive: true });
  for (const filename of files) {
    if (fs.existsSync(filename)) fs.renameSync(filename, path.join(history, path.basename(filename)));
  }
}

function backupOriginal(config, tools, target, pair, promptState, simulate) {
  const root = backupDirectory(config, tools, target);
  const backupVideo = path.join(root, path.basename(pair.video));
  const backupInfo = path.join(root, path.basename(pair.info));
  const collision = fs.existsSync(backupVideo) || fs.existsSync(backupInfo);
  if (collision && simulate) {
    console.log(`[quality] [WOULD PROMPT] active backup exists: ${path.relative(tools.stateDirectory, backupVideo)}`);
  } else if (collision && !askBackupConflict(path.relative(tools.stateDirectory, backupVideo), promptState)) {
    console.log(`[quality] skip ${pair.id}: existing backup was not approved for replacement`);
    return null;
  }
  if (simulate) return { backupVideo, backupInfo };
  if (collision) moveActiveBackupToHistory(root, [backupVideo, backupInfo]);
  copyVerified(pair.video, backupVideo);
  copyVerified(pair.info, backupInfo);
  return { backupVideo, backupInfo };
}

function transactionFile(tools, id) {
  return path.join(tools.stateDirectory, 'quality-transactions', `${uniqueStamp()}-${id}.json`);
}

function installPair(tools, pair, candidateVideo, candidateInfo, operation) {
  const nonce = `${process.pid}-${Date.now()}`;
  const newVideo = `${pair.video}.quality-new-${nonce}`;
  const newInfo = `${pair.info}.quality-new-${nonce}`;
  const oldVideo = `${pair.video}.quality-old-${nonce}`;
  const oldInfo = `${pair.info}.quality-old-${nonce}`;
  copyVerified(candidateVideo, newVideo);
  copyVerified(candidateInfo, newInfo);
  const manifest = transactionFile(tools, pair.id);
  const transaction = { operation, status: 'prepared', pair, newVideo, newInfo, oldVideo, oldInfo };
  writeJsonAtomic(manifest, transaction);
  fs.renameSync(pair.video, oldVideo);
  fs.renameSync(pair.info, oldInfo);
  transaction.status = 'originals-moved';
  writeJsonAtomic(manifest, transaction);
  fs.renameSync(newVideo, pair.video);
  fs.renameSync(newInfo, pair.info);
  transaction.status = 'installed';
  writeJsonAtomic(manifest, transaction);
  transaction.status = 'complete';
  writeJsonAtomic(manifest, transaction);
  // Completion is durable before redundant transaction copies are removed. A
  // crash can therefore leave extra recoverable files, never a missing pair.
  try { fs.unlinkSync(oldVideo); } catch (error) { /* retained safely */ }
  try { fs.unlinkSync(oldInfo); } catch (error) { /* retained safely */ }
}

function preserveRecoveryFile(tools, filename) {
  if (!fs.existsSync(filename)) return;
  const destination = path.join(tools.stateDirectory, 'quality-recovery', uniqueStamp(), path.basename(filename));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(filename, destination);
}

function recoverTransactions(tools) {
  const directory = path.join(tools.stateDirectory, 'quality-transactions');
  if (!fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory).filter((item) => item.endsWith('.json'))) {
    const filename = path.join(directory, name);
    const transaction = readJson(filename);
    if (transaction.status === 'complete' || transaction.status === 'rolled-back') continue;
    for (const [original, old, fresh] of [
      [transaction.pair.video, transaction.oldVideo, transaction.newVideo],
      [transaction.pair.info, transaction.oldInfo, transaction.newInfo]
    ]) {
      if (fs.existsSync(old)) {
        if (fs.existsSync(original)) preserveRecoveryFile(tools, original);
        fs.renameSync(old, original);
      }
      preserveRecoveryFile(tools, fresh);
    }
    transaction.status = 'rolled-back';
    transaction.rolledBackAt = new Date().toISOString();
    writeJsonAtomic(filename, transaction);
    console.log(`[quality] recovered interrupted ${transaction.operation} for ${transaction.pair.id}`);
  }
}

function validateCandidate(pair, candidateVideo, candidateInfo, oldQuality) {
  const info = readJson(candidateInfo);
  if (String(info.id) !== pair.id) throw new Error(`downloaded metadata ID ${info.id} does not match ${pair.id}`);
  const quality = probeVideo(candidateVideo);
  if (!/(?:^|,)mp4(?:,|$)/u.test(quality.format)) throw new Error(`downloaded container is not MP4 (${quality.format || 'unknown'})`);
  if (normalizeCodec(quality.audioCodec) !== 'aac') throw new Error(`downloaded audio is not AAC (${quality.audioCodec})`);
  const reason = compareQuality(oldQuality, quality);
  if (!reason) throw new Error('downloaded file is not better than the archived file');
  if (oldQuality.duration && quality.duration && Math.abs(oldQuality.duration - quality.duration) > Math.max(5, oldQuality.duration * 0.02)) {
    throw new Error(`duration changed unexpectedly (${oldQuality.duration}s -> ${quality.duration}s)`);
  }
  return { quality, reason };
}

function findDownloadedPair(directory, id) {
  const entries = fs.readdirSync(directory);
  const video = entries.find((name) => name.endsWith('.mp4'));
  const info = entries.find((name) => name.endsWith('.info.json'));
  if (!video || !info) throw new Error(`yt-dlp did not produce a complete MP4/info pair for ${id}`);
  return { video: path.join(directory, video), info: path.join(directory, info) };
}

function downloadCandidate(config, tools, target, id, staging) {
  fs.mkdirSync(staging, { recursive: true });
  run(tools.ytDlp, [
    ...videoCoreArgs(config, tools, target), ...(target.extraArgs || []),
    '--no-overwrites', '--no-playlist',
    '--output', path.join(staging, '%(id)s.%(ext)s'),
    `https://youtu.be/${id}`
  ], { cwd: resolveArchive(config, target.directory), errorLabel: 'yt-dlp' });
  return findDownloadedPair(staging, id);
}

function qualityLabel(quality) {
  return `${quality.width}x${quality.height} ${normalizeCodec(quality.videoCodec)} + ${normalizeCodec(quality.audioCodec)}`;
}

function migrateQuality(config, tools, options) {
  const pins = loadPins(tools);
  const promptState = { all: false };
  let changes = 0;
  let failures = 0;
  for (const target of enabledTargets(config)) {
    for (const pair of pairsForTarget(config, target)) {
      if (pins[path.resolve(pair.video)]) {
        console.log(`[quality] pinned after restore; skip ${path.relative(resolveArchive(config), pair.video)}`);
        continue;
      }
      try {
        const existing = probeVideo(pair.video);
        const candidate = queryCandidate(config, tools, target, pair.id);
        const reason = compareQuality(existing, candidate.quality);
        if (!reason) continue;
        const relative = path.relative(resolveArchive(config), pair.video);
        console.log(`[quality] upgrade available ${relative}: ${qualityLabel(existing)} -> ${qualityLabel(candidate.quality)} (${reason})`);
        if (options.simulate) {
          const backup = backupOriginal(config, tools, target, pair, promptState, true);
          if (!backup) continue;
          console.log(`[quality] would download, verify, back up, and replace ${relative}`);
          changes += 1;
          continue;
        }
        const staging = path.join(tools.stateDirectory, 'quality-staging', `${pair.id}-${process.pid}-${Date.now()}`);
        const downloaded = downloadCandidate(config, tools, target, pair.id, staging);
        const verified = validateCandidate(pair, downloaded.video, downloaded.info, existing);
        const backup = backupOriginal(config, tools, target, pair, promptState, false);
        if (!backup) {
          fs.rmSync(staging, { recursive: true, force: true });
          continue;
        }
        installPair(tools, pair, downloaded.video, downloaded.info, 'migrate-quality');
        fs.rmSync(staging, { recursive: true, force: true });
        console.log(`[quality] upgraded ${relative}: ${verified.reason}`);
        changes += 1;
      } catch (error) {
        failures += 1;
        console.warn(`[quality] unable to process ${target.directory} / ${pair.id}: ${formatProcessError(error)}`);
      }
    }
  }
  console.log(`[quality] ${options.simulate ? 'would upgrade' : 'upgraded'} ${changes} video${changes === 1 ? '' : 's'}`);
  return failures;
}

function backupPairsForTarget(config, tools, target) {
  const root = backupDirectory(config, tools, target);
  if (!fs.existsSync(root)) return [];
  const pairs = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.info.json')) continue;
    const info = path.join(root, entry.name);
    const video = path.join(root, `${entry.name.slice(0, -10)}.mp4`);
    if (!fs.existsSync(video)) continue;
    const metadata = readJson(info);
    if (metadata.id) pairs.push({ id: String(metadata.id), video, info });
  }
  return pairs;
}

function revertQuality(config, tools, options) {
  const pins = loadPins(tools);
  let reverted = 0;
  let failures = 0;
  for (const target of enabledTargets(config)) {
    const root = backupDirectory(config, tools, target);
    const targetDirectory = resolveArchive(config, target.directory);
    for (const backup of backupPairsForTarget(config, tools, target)) {
      const pair = {
        id: backup.id,
        video: path.join(targetDirectory, path.basename(backup.video)),
        info: path.join(targetDirectory, path.basename(backup.info))
      };
      try {
        const backupQuality = probeVideo(backup.video);
        const relative = path.relative(resolveArchive(config), pair.video);
        console.log(`[quality] ${options.simulate ? 'would revert' : 'revert'} ${relative} (${qualityLabel(backupQuality)})`);
        if (options.simulate) {
          reverted += 1;
          continue;
        }
        const history = path.join(root, '.history', `${uniqueStamp()}-pre-restore`);
        fs.mkdirSync(history, { recursive: true });
        if (fs.existsSync(pair.video)) copyVerified(pair.video, path.join(history, path.basename(pair.video)));
        if (fs.existsSync(pair.info)) copyVerified(pair.info, path.join(history, path.basename(pair.info)));
        if (!fs.existsSync(pair.video) || !fs.existsSync(pair.info)) {
          throw new Error('live MP4/info pair is incomplete; refusing automatic restore');
        }
        installPair(tools, pair, backup.video, backup.info, 'migrate-quality-revert');
        const revertedHistory = path.join(root, '.history', `${uniqueStamp()}-reverted-original`);
        fs.mkdirSync(revertedHistory, { recursive: true });
        fs.renameSync(backup.video, path.join(revertedHistory, path.basename(backup.video)));
        fs.renameSync(backup.info, path.join(revertedHistory, path.basename(backup.info)));
        pins[path.resolve(pair.video)] = { revertedAt: new Date().toISOString(), id: pair.id };
        writeJsonAtomic(pinsFile(tools), pins);
        reverted += 1;
      } catch (error) {
        failures += 1;
        console.warn(`[quality] unable to revert ${target.directory} / ${backup.id}: ${formatProcessError(error)}`);
      }
    }
  }
  console.log(`[quality] ${options.simulate ? 'would revert' : 'reverted'} ${reverted} video${reverted === 1 ? '' : 's'}`);
  return failures;
}

function countMp4(directory) {
  if (!fs.existsSync(directory)) return 0;
  let count = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(filename);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp4')) count += 1;
    }
  }
  return count;
}

function printBackupSummary(config, tools) {
  console.log('\n==================== QUALITY BACKUPS ====================');
  let locations = 0;
  let videos = 0;
  for (const target of enabledTargets(config)) {
    const directory = backupDirectory(config, tools, target);
    const count = countMp4(directory);
    if (count === 0) continue;
    locations += 1;
    videos += count;
    console.log(`${directory} — ${count} video${count === 1 ? '' : 's'}`);
  }
  console.log(`Total retained quality backups: ${videos} video${videos === 1 ? '' : 's'} in ${locations} location${locations === 1 ? '' : 's'}`);
}

function runQualityMode(config, tools, options) {
  let failures = 0;
  try {
    if (!options.simulate) recoverTransactions(tools);
    failures += options.migrateQualityRevert
      ? revertQuality(config, tools, options)
      : migrateQuality(config, tools, options);
  } catch (error) {
    failures += 1;
    console.error(`[quality] ${formatProcessError(error)}`);
  } finally {
    // This must remain the final output so retained copies are never forgotten.
    printBackupSummary(config, tools);
  }
  return failures;
}

module.exports = {
  backupDirectory, compareQuality, printBackupSummary, runQualityMode, safeTargetPath, selectedStreams,
  _test: { installPair, recoverTransactions }
};
