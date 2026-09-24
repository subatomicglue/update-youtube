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

function parseArguments(argv) {
  const options = { simulate: false, skipUpdate: false, skipInfoBackfill: false, apply: false, config: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === 'sim' || argument === '--simulate' || argument === '-n') options.simulate = true;
    else if (argument === '--skip-update') options.skipUpdate = true;
    else if (argument === '--skip-info-backfill') options.skipInfoBackfill = true;
    else if (argument === '--apply') options.apply = true;
    else if (argument === '--config') options.config = argv[++index];
    else if (argument === '--help-migrate') options.helpMigrate = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: update-youtube [options]\n\n` +
    `  --config FILE    Use an alternate base config (default: config.json)\n` +
    `  --simulate, -n   Pass --simulate to yt-dlp and preview filesystem work\n` +
    `  --apply          Apply a validated naming migration plan\n` +
    `  --skip-update    Use the cached yt-dlp without checking GitHub\n` +
    `  --skip-info-backfill  Do not fill missing .info.json files\n` +
    `  --help-migrate   Show the naming-migration guide\n` +
    `  --help, -h       Show this help\n\n` +
    `npm commands:\n\n` +
    `  npm run help      Show this help\n` +
    `  npm test          Run the test suite\n` +
    `  npm run simulate  Preview an archive run\n` +
    `  npm run archive   Run the archiver from source\n` +
    `  npm run build     Build all standalone bundles into dist/\n\n` +
    `Naming migration: run update-youtube --help-migrate\n\n` +
    `Build outputs:\n\n` +
    `  dist/update-youtube-macos-x64\n` +
    `  dist/update-youtube-macos-arm64\n` +
    `  dist/update-youtube-win-x64.exe\n` +
    `  dist/update-youtube-linux-x64\n` +
    `  dist/update-youtube-linux-arm64`);
}

function printMigrationHelp() {
  console.log(`Naming migration:\n\n` +
    `  Set the target's desired namingProfile and its previous profile:\n\n` +
    `    {\n` +
    `      "namingProfile": "dated-with-id",\n` +
    `      "migrateFrom": "dated"\n` +
    `    }\n\n` +
    `  Available profiles: title, dated, title-with-id, dated-with-id\n` +
    `  migrateFrom may also be an array of previous profile names.\n` +
    `  Run normally to preview the automatic migration plan. No files move.\n` +
    `  After reviewing the plan, apply it with:\n\n` +
    `    update-youtube --apply\n\n` +
    `  If no old-format files exist, the normal archive workflow continues.\n` +
    `  --simulate --apply is always non-destructive.`);
}

function printBanner(title) {
  console.log(`\n==================== ${title} ====================`);
}

async function main() {
  if (process.argv[2] === 'scp-transcripts') {
    const [, , , directory = 'Transcripts-YouTube', destination] = process.argv;
    scpTranscripts(path.resolve(directory), destination);
    return;
  }
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return printHelp();
  if (options.helpMigrate) return printMigrationHelp();
  options.config = findConfigPath(options.config, [process.cwd(), __dirname, path.dirname(process.execPath)]);
  const config = loadConfig(options.config);
  console.log(`[config] ${path.resolve(options.config)}`);
  console.log(`[config] customconfig.json ${config.customConfigLoaded ? 'loaded' : 'not present'}`);
  //printBanner('TOOLS');
  const tools = await ensureTools(config, options);
  assertCookieAccess(config);
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
      console.error(`\n[ERROR] ${unreported.length} operation${unreported.length === 1 ? '' : 's'} failed:`);
      for (const error of unreported) console.error(`  - ${error}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\n[ERROR] ${error.message}`);
  process.exitCode = 1;
});
