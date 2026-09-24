'use strict';

const fs = require('fs');
const path = require('path');

const APPEND_ARRAY_KEYS = new Set([
  'targets', 'linkRules', 'transcriptDirectories', 'postSteps'
]);

function mergeConfig(base, custom, key = '') {
  if (Array.isArray(base) && Array.isArray(custom)) {
    return APPEND_ARRAY_KEYS.has(key) ? [...base, ...custom] : [...custom];
  }
  if (isObject(base) && isObject(custom)) {
    const result = { ...base };
    for (const [childKey, value] of Object.entries(custom)) {
      result[childKey] = childKey in result
        ? mergeConfig(result[childKey], value, childKey)
        : value;
    }
    return result;
  }
  return custom;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(filename, required = true) {
  if (!fs.existsSync(filename)) {
    if (!required) return null;
    throw new Error(`Configuration file not found: ${filename}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to parse ${filename}: ${error.message}`);
  }
}

function loadConfig(configPath) {
  const absoluteConfig = path.resolve(configPath || 'config.json');
  const configDirectory = path.dirname(absoluteConfig);
  const base = readJson(absoluteConfig);
  const customPath = path.join(configDirectory, 'customconfig.json');
  const custom = readJson(customPath, false);
  const config = custom ? mergeConfig(base, custom) : base;
  config.configDirectory = configDirectory;
  config.workingDirectory = process.cwd();
  config.customConfigLoaded = Boolean(custom);
  return config;
}

function findConfigPath(explicit, directories) {
  if (explicit) return path.resolve(explicit);
  const candidates = directories.map((directory) => path.resolve(directory, 'config.json'));
  return candidates.find((candidate, index) => candidates.indexOf(candidate) === index && fs.existsSync(candidate))
    || candidates[0];
}

function resolveFromConfig(config, value) {
  if (!value) return config.configDirectory;
  return path.isAbsolute(value) ? value : path.resolve(config.configDirectory, value);
}

function resolveArchive(config, value = '.') {
  const archiveDirectory = config.archiveDirectory || '.';
  const archiveRoot = path.isAbsolute(archiveDirectory)
    ? archiveDirectory
    : path.resolve(config.workingDirectory || process.cwd(), archiveDirectory);
  if (path.isAbsolute(value)) return value;
  return path.resolve(archiveRoot, value);
}

module.exports = { findConfigPath, loadConfig, mergeConfig, resolveArchive, resolveFromConfig };
