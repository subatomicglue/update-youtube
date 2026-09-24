'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('./process');
const { resolveArchive } = require('./config');

function targetProfile(config, target, profileName = target.namingProfile) {
  if (!profileName || !config.namingProfiles || !config.namingProfiles[profileName]) {
    throw new Error(`Unknown naming profile "${profileName || ''}" for ${target.directory}.`);
  }
  const profile = config.namingProfiles[profileName];
  if (!profile.video) throw new Error(`Naming profile "${profileName}" has no video template.`);
  return profile;
}

function renderFilename(ytDlp, infoJson, template, cwd) {
  const result = run(ytDlp, [
    '--load-info-json', infoJson,
    '--skip-download', '--ignore-no-formats-error', '--quiet', '--no-warnings',
    '--print', 'filename', '--output', template
  ], { cwd, capture: true, quiet: true });
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error(`yt-dlp returned ${lines.length} filenames for ${infoJson}.`);
  return lines[0];
}

function safeDestination(directory, rendered) {
  const destination = path.resolve(directory, rendered);
  const relative = path.relative(directory, destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Naming template escapes target directory: ${rendered}`);
  }
  return destination;
}

function replaceExtension(filename, extension) {
  return `${filename.slice(0, -path.extname(filename).length)}${extension}`;
}

function addMove(moves, source, destination, description) {
  if (path.resolve(source) === path.resolve(destination)) return;
  moves.push({ source, destination, description });
}

function buildTargetPlan(config, tools, target) {
  const directory = resolveArchive(config, target.directory);
  if (!fs.existsSync(directory)) return { moves: [], problems: [] };
  const active = targetProfile(config, target);
  const oldNames = Array.isArray(target.migrateFrom) ? target.migrateFrom : [target.migrateFrom];
  const oldProfiles = oldNames.map((name) => ({ name, profile: targetProfile(config, target, name) }));
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const infoFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.info.json'));
  const moves = [];
  const problems = [];

  for (const entry of infoFiles) {
    const infoJson = path.join(directory, entry.name);
    let metadata;
    try {
      metadata = JSON.parse(fs.readFileSync(infoJson, 'utf8'));
    } catch (error) {
      problems.push(`${entry.name}: invalid info JSON (${error.message})`);
      continue;
    }
    if (!metadata.id || !metadata.ext) {
      problems.push(`${entry.name}: missing id or ext metadata`);
      continue;
    }

    let renderedNew;
    let renderedOld;
    let matchedProfile;
    try {
      renderedNew = renderFilename(tools.ytDlp, infoJson, active.video, directory);
      for (const candidate of oldProfiles) {
        const rendered = renderFilename(tools.ytDlp, infoJson, candidate.profile.video, directory);
        const expectedInfo = replaceExtension(rendered, '.info.json');
        if (path.normalize(expectedInfo) === path.normalize(entry.name)) {
          renderedOld = rendered;
          matchedProfile = candidate;
          break;
        }
      }
    } catch (error) {
      problems.push(`${entry.name}: unable to render filename (${error.message})`);
      continue;
    }

    if (!matchedProfile) {
      const expectedNewInfo = replaceExtension(renderedNew, '.info.json');
      if (path.normalize(expectedNewInfo) === path.normalize(entry.name)) continue;
      problems.push(`${entry.name}: does not match the active profile or any migrateFrom profile`);
      continue;
    }

    const oldVideo = safeDestination(directory, renderedOld);
    const newVideo = safeDestination(directory, renderedNew);
    if (!fs.existsSync(oldVideo)) {
      problems.push(`${entry.name}: expected legacy video is missing (${path.basename(oldVideo)})`);
      continue;
    }
    addMove(moves, oldVideo, newVideo, 'video');
    addMove(moves, infoJson, replaceExtension(newVideo, '.info.json'), 'metadata');

    const subtitleTemplate = active.subtitle || active.video;
    let renderedSubtitle;
    try {
      renderedSubtitle = renderFilename(tools.ytDlp, infoJson, subtitleTemplate, directory);
    } catch (error) {
      problems.push(`${entry.name}: unable to render subtitle filename (${error.message})`);
      continue;
    }
    const newSubtitleStem = replaceExtension(safeDestination(directory, renderedSubtitle), '');
    for (const subtitle of entries) {
      if (!subtitle.isFile() || !subtitle.name.includes(metadata.id)) continue;
      const match = subtitle.name.match(/(\.[^.]+\.srt(?:\.json)?)$/u);
      if (!match) continue;
      addMove(moves, path.join(directory, subtitle.name), `${newSubtitleStem}${match[1]}`, 'subtitle');
    }
  }
  return { moves, problems };
}

function validatePlan(plan) {
  const destinations = new Map();
  for (const move of plan.moves) {
    const destination = path.resolve(move.destination);
    if (destinations.has(destination)) {
      plan.problems.push(`multiple files would move to ${move.destination}`);
    }
    destinations.set(destination, move.source);
    if (fs.existsSync(move.destination) && path.resolve(move.source) !== destination) {
      plan.problems.push(`destination already exists: ${move.destination}`);
    }
  }
}

function printPlan(config, plan, applying) {
  const color = process.stdout.isTTY ? '\u001b[31;1m' : '';
  const reset = process.stdout.isTTY ? '\u001b[0m' : '';
  console.log(`\n${color}==================== MIGRATE ====================${reset}`);
  for (const move of plan.moves) {
    const archiveDirectory = resolveArchive(config);
    console.log(`[MOVE:${move.description}] ${path.relative(archiveDirectory, move.source)} -> ${path.relative(archiveDirectory, move.destination)}`);
  }
  for (const problem of plan.problems) console.log(`${color}[BLOCKED] ${problem}${reset}`);
  if (!applying) {
    console.log(`\n${color}No files were changed. Review this plan, then rerun with --apply.${reset}`);
  }
}

function saveManifest(filename, manifest) {
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  if (process.platform === 'win32' && fs.existsSync(filename)) fs.unlinkSync(filename);
  fs.renameSync(temporary, filename);
}

function writeManifest(appDirectory, plan) {
  const directory = path.join(appDirectory, 'migrations');
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const filename = path.join(directory, `${stamp}.json`);
  saveManifest(filename, {
    createdAt: new Date().toISOString(),
    status: 'pending',
    moves: plan.moves.map((move) => ({ ...move, status: 'pending' }))
  });
  return filename;
}

function pendingManifest(appDirectory) {
  const directory = path.join(appDirectory, 'migrations');
  if (!fs.existsSync(directory)) return null;
  const filenames = fs.readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse();
  for (const name of filenames) {
    const filename = path.join(directory, name);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid migration manifest ${filename}: ${error.message}`);
    }
    if (manifest.status === 'pending') return { filename, manifest };
  }
  return null;
}

function applyManifest(filename, manifest) {
  for (const move of manifest.moves) {
    if (move.status === 'complete') continue;
    const sourceExists = fs.existsSync(move.source);
    const destinationExists = fs.existsSync(move.destination);
    if (sourceExists && !destinationExists) {
      fs.mkdirSync(path.dirname(move.destination), { recursive: true });
      fs.renameSync(move.source, move.destination);
    } else if (sourceExists && destinationExists) {
      throw new Error(`Migration blocked because both source and destination exist: ${move.source} -> ${move.destination}`);
    } else if (!destinationExists) {
      throw new Error(`Migration blocked because both source and destination are missing: ${move.source} -> ${move.destination}`);
    }
    move.status = 'complete';
    move.completedAt = new Date().toISOString();
    saveManifest(filename, manifest);
  }
  manifest.status = 'complete';
  manifest.completedAt = new Date().toISOString();
  saveManifest(filename, manifest);
  console.log(`Migration complete. Manifest: ${filename}`);
}

function handleMigrations(config, tools, options) {
  const stateDirectory = tools.stateDirectory || tools.appDirectory;
  const pending = pendingManifest(stateDirectory);
  if (pending) {
    const remaining = pending.manifest.moves.filter((move) => move.status !== 'complete');
    console.log(`\n[migration] Resuming pending manifest: ${pending.filename}`);
    printPlan(config, { moves: remaining, problems: [] }, options.apply && !options.simulate);
    if (!options.apply || options.simulate) return { required: true, applied: false };
    applyManifest(pending.filename, pending.manifest);
    return { required: true, applied: true };
  }
  const targets = (config.targets || []).filter((target) => target.enable !== 0 && target.enabled !== false && target.migrateFrom);
  if (targets.length === 0) return { required: false, applied: false };
  const plan = { moves: [], problems: [] };
  for (const target of targets) {
    const targetPlan = buildTargetPlan(config, tools, target);
    plan.moves.push(...targetPlan.moves);
    plan.problems.push(...targetPlan.problems.map((problem) => `${target.directory}: ${problem}`));
  }
  validatePlan(plan);
  if (plan.moves.length === 0 && plan.problems.length === 0) return { required: false, applied: false };

  const applying = options.apply && !options.simulate && plan.problems.length === 0;
  printPlan(config, plan, applying);
  if (plan.problems.length > 0) return { required: true, applied: false };
  if (!applying) return { required: true, applied: false };

  const manifest = writeManifest(stateDirectory, plan);
  applyManifest(manifest, JSON.parse(fs.readFileSync(manifest, 'utf8')));
  return { required: true, applied: true };
}

module.exports = { handleMigrations, targetProfile };
