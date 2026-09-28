#!/usr/bin/env node
'use strict';

const path = require('path');
const { findConfigPath, loadConfig } = require('./lib/config');
const { ensureTools } = require('./lib/tools');
const {
  applyLinkRules, assertCookieAccess, backfillInfo, collectTranscripts, downloadTarget,
  repairArchivedVideos, runPostSteps
} = require('./lib/archive');
const { scpTranscripts } = require('./lib/scp-transcripts');
const { handleMigrations } = require('./lib/migrate');
const { runQualityMode } = require('./lib/quality');
const { printAssets, printDetailedAssets, printGroups } = require('./lib/list-assets');
const { printValidation } = require('./lib/validate');
const { errorText } = require('./lib/process');
const { main: transcriptMain } = require('./lib/transcript');

function parseArguments(argv) {
  const options = {
    simulate: false, skipUpdate: false, skipInfoBackfill: false, apply: false, config: null,
    migrateQuality: false, migrateQualityRevert: false, list: false, listDetails: false,
    listGroup: null, listGroups: false, validate: false, runGroup: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === 'sim' || argument === '--simulate' || argument === '--dry-run' || argument === '-n') options.simulate = true;
    else if (argument === '--migrate-quality') options.migrateQuality = true;
    else if (argument === '--migrate-quality-audit') {
      options.migrateQuality = true;
      options.simulate = true;
    } else if (argument === '--migrate-quality-revert') options.migrateQualityRevert = true;
    else if (argument === '--list') {
      options.list = true;
      if (argv[index + 1] && !argv[index + 1].startsWith('-')) options.listGroup = argv[++index];
    } else if (argument.startsWith('--list=')) {
      options.list = true;
      options.listGroup = argument.slice('--list='.length);
      if (!options.listGroup) throw new Error('--list= requires a group name.');
    } else if (argument === '--list-details') {
      options.listDetails = true;
      if (argv[index + 1] && !argv[index + 1].startsWith('-')) options.listGroup = argv[++index];
    } else if (argument.startsWith('--list-details=')) {
      options.listDetails = true;
      options.listGroup = argument.slice(argument.indexOf('=') + 1);
      if (!options.listGroup) throw new Error(`${argument.split('=')[0]}= requires a group name.`);
    } else if (argument === '--list-groups') options.listGroups = true;
    else if (argument === '--validate') {
      options.validate = true;
      if (argv[index + 1] && !argv[index + 1].startsWith('-')) options.listGroup = argv[++index];
    } else if (argument.startsWith('--validate=')) {
      options.validate = true;
      options.listGroup = argument.slice('--validate='.length);
      if (!options.listGroup) throw new Error('--validate= requires a group name.');
    }
    else if (argument === '--skip-update') options.skipUpdate = true;
    else if (argument === '--skip-info-backfill') options.skipInfoBackfill = true;
    else if (argument === '--apply') options.apply = true;
    else if (argument === '--config') options.config = argv[++index];
    else if (argument === '--help-migrate') options.helpMigrate = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (!argument.startsWith('-') && !options.runGroup) options.runGroup = argument;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.migrateQuality && options.migrateQualityRevert) {
    throw new Error('--migrate-quality and --migrate-quality-revert are mutually exclusive.');
  }
  if ([options.list, options.listDetails, options.listGroups, options.validate].filter(Boolean).length > 1) {
    throw new Error('--list, --list-details, --list-groups, and --validate are mutually exclusive.');
  }
  if (options.runGroup && (options.list || options.listDetails || options.listGroups || options.validate)) {
    throw new Error('A focused archive group cannot be combined with a list or validation command.');
  }
  return options;
}

function focusConfig(config, group) {
  const target = (config.targets || []).find((candidate) => candidate.directory === group);
  if (!target) throw new Error(`Unknown group: ${group}`);
  return {
    ...config,
    targets: [{ ...target, enable: 1, enabled: true }],
    linkRules: (config.linkRules || []).filter((rule) => rule.sourceDirectory === group),
    transcriptDirectories: [group],
    postSteps: []
  };
}

function printHelp() {
  console.log(`Usage: update-youtube [GROUP] [options]\n\n` +
    `  GROUP            Run one exact configured target, regardless of its enable setting\n` +
    `  --config FILE    Use an alternate base config (default: config.json)\n` +
    `  --simulate, --dry-run, -n  Preview filesystem work without changing files\n` +
    `  --migrate-quality          Safely replace archived videos when configured quality is better\n` +
    `  --migrate-quality-audit    Alias for --migrate-quality --simulate\n` +
    `  --migrate-quality-revert   Put original files back; preserve upgraded copies in backup history\n` +
    `  --list [GROUP]             List archived MP4 assets, grouped by target; optionally show one group\n` +
    `  --list-details [GROUP]     List assets with aligned [resolution:video-codec:audio-codec]\n` +
    `  --list-groups              List configured target-group names only\n` +
    `  --validate [GROUP]         List missing video, .info.json, .srt, and .srt.json files\n` +
    `  --apply          Apply a validated naming migration plan\n` +
    `  --skip-update    Use the cached yt-dlp without checking GitHub\n` +
    `  --skip-info-backfill  Do not fill missing .info.json files\n` +
    `  --help-migrate   Show the naming-migration guide\n` +
    `  --help, -h       Show this help\n\n` +
    `Transcript generation:\n\n` +
    `  update-youtube --transcript [options] FILE_OR_DIRECTORY\n` +
    `  Missing YouTube subtitles automatically fall back to local transcription.\n` +
    `  Run update-youtube --transcript --help for backend options.\n\n` +
    `npm commands:\n\n` +
    `  npm run help      Show this help\n` +
    `  npm test          Run the test suite\n` +
    `  npm run simulate  Preview an archive run\n` +
    `  npm run archive   Run the archiver from source\n` +
    `  npm run build     Build all standalone bundles into dist/\n\n` +
    `Naming migration: set namingProfile and migrateFrom, preview normally, then rerun with --apply.\n` +
    `Run update-youtube --help-migrate for the complete, resumable procedure.\n\n` +
    `Build outputs:\n\n` +
    `  dist/update-youtube-macos-x64\n` +
    `  dist/update-youtube-macos-arm64\n` +
    `  dist/update-youtube-win-x64.exe\n` +
    `  dist/update-youtube-linux-x64\n` +
    `  dist/update-youtube-linux-arm64`);
}

function printMigrationHelp() {
  console.log(`Naming migration:\n\n` +
    `  1. Validate the group before changing its profile:\n\n` +
    `    update-youtube --validate "GROUP"\n\n` +
    `  Resolve every missing .info.json first; metadata is required to calculate safe moves.\n` +
    `  2. Set the target's desired namingProfile and its previous profile:\n\n` +
    `    {\n` +
    `      "namingProfile": "dated-with-id",\n` +
    `      "migrateFrom": "dated"\n` +
    `    }\n\n` +
    `  To add IDs, migrate title -> title-with-id or dated -> dated-with-id.\n` +
    `  Available profiles: title, dated, title-with-id, dated-with-id\n` +
    `  migrateFrom may also be an array of previous profile names.\n` +
    `  If the target is a linkRules sourceDirectory, update and test its link rules before applying;\n` +
    `  otherwise existing generated symlinks can retain the old names or become broken.\n` +
    `  3. Run normally, optionally with one GROUP, to preview the plan. No files move.\n\n` +
    `    update-youtube "GROUP"\n\n` +
    `  4. Review every proposed MP4, metadata, SRT, and SRT-JSON move.\n` +
    `  5. Apply that group after reviewing it:\n\n` +
    `    update-youtube "GROUP" --apply\n\n` +
    `  6. Run validation for that group:\n\n` +
    `    update-youtube --validate "GROUP"\n\n` +
    `  To migrate every enabled target together, omit GROUP:\n\n` +
    `    update-youtube --apply\n\n` +
    `  Applied moves are journaled and safely resume after interruption.\n` +
    `  If no old-format files exist, the normal archive workflow continues.\n` +
    `  --simulate --apply is always non-destructive.`);
}

function printBanner(title) {
  console.log(`\n==================== ${title} ====================`);
}

async function main() {
  if (process.argv[2] === '--transcript') {
    const cacheDirectory = path.join(process.pkg ? path.dirname(process.execPath) : __dirname, '.generate-transcript');
    process.exitCode = transcriptMain(process.argv.slice(3), {
      cacheDirectory, commandName: 'update-youtube --transcript'
    });
    return;
  }
  if (process.argv[2] === 'scp-transcripts') {
    const [, , , directory = 'Transcripts-YouTube', destination] = process.argv;
    scpTranscripts(path.resolve(directory), destination);
    return;
  }
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return printHelp();
  if (options.helpMigrate) return printMigrationHelp();
  options.config = findConfigPath(options.config, [process.cwd(), __dirname, path.dirname(process.execPath)]);
  let config = loadConfig(options.config);
  if (options.listGroups) return printGroups(config);
  if (options.listDetails) return printDetailedAssets(config, options.listGroup);
  if (options.list) return printAssets(config, options.listGroup);
  if (options.validate) {
    if (printValidation(config, options.listGroup) > 0) process.exitCode = 1;
    return;
  }
  if (options.runGroup) config = focusConfig(config, options.runGroup);
  console.log(`[config] ${path.resolve(options.config)}`);
  console.log(`[config] customconfig.json ${config.customConfigLoaded ? 'loaded' : 'not present'}`);
  if (options.runGroup) console.log(`[group] ${options.runGroup}`);
  //printBanner('TOOLS');
  const tools = await ensureTools(config, options);
  assertCookieAccess(config);
  if (options.migrateQuality || options.migrateQualityRevert) {
    printBanner(options.migrateQualityRevert ? 'QUALITY REVERT' : 'QUALITY MIGRATION');
    if (runQualityMode(config, tools, options) > 0) process.exitCode = 1;
    return;
  }
  printBanner('ARCHIVE');
  backfillInfo(config, tools, options);
  repairArchivedVideos(config, tools, options);
  const migration = handleMigrations(config, tools, options);
  if (migration.required && !migration.applied) {
    process.exitCode = 3;
    return;
  }
  const errors = [];
  for (const target of config.targets || []) {
    if (target.enable === 0 || target.enabled === false) continue;
    try {
      errors.push(...downloadTarget(config, tools, target, options));
    } catch (error) {
      errors.push(`${target.directory}: ${error.message}`);
    }
  }
  errors.push(...applyLinkRules(config, tools.appDirectory, options));
  errors.push(...collectTranscripts(config, options));
  errors.push(...runPostSteps(config, { ...options, entrypoint: __filename }));
  if (errors.length > 0) {
    const unreported = errors.filter(Boolean);
    if (unreported.length > 0) {
      console.error(errorText(`\n[ERROR] ${unreported.length} operation${unreported.length === 1 ? '' : 's'} failed:`));
      for (const error of unreported) console.error(`  - ${error}`);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(errorText(`\n[ERROR] ${error.message}`));
    process.exitCode = 1;
  });
}

module.exports = { focusConfig, main, parseArguments };
