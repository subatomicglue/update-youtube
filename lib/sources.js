'use strict';

const path = require('path');

function validName(name) {
  return typeof name === 'string' && name.trim() === name && name.length > 0
    && name !== '.' && name !== '..' && path.basename(name) === name
    && !/[\\/\0]/u.test(name);
}

function sourceOutputTemplate(source, template, profileName = source.namingProfile || 'title') {
  if (source.sourceKind !== 'video') return template;
  if (!template || !template.includes('%(title)s')) {
    throw new Error(`Naming profile "${profileName}" must contain %(title)s for named video ${source.name}.`);
  }
  return template.split('%(title)s').join(source.name.replace(/%/gu, '%%'));
}

function namedVideoSource(directory, entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`targets URL entry ${index} for ${directory} must be an object.`);
  }
  if (typeof entry.url !== 'string' || !entry.url.trim()) {
    throw new Error(`targets URL entry ${index} for ${directory} must have a non-empty url.`);
  }
  const name = entry.name;
  if (!validName(name)) {
    throw new Error(`targets URL entry ${index} for ${directory} must have a plain name without a directory or extension.`);
  }
  if (path.extname(name)) {
    throw new Error(`targets URL entry ${index} for ${directory} must have a name without an extension.`);
  }
  return {
    ...entry,
    name,
    directory,
    sourceKind: 'video',
    archive: entry.archive || `${name}.archive.txt`
  };
}

// Normalize a target's string or array URL field into one source record per
// yt-dlp invocation. Named object entries are individual videos; strings and
// unnamed objects retain playlist behavior.
function injectSources(config) {
  const targets = [];
  const namesByDirectory = new Map();
  for (const target of config.targets || []) {
    const entries = Array.isArray(target.url) ? target.url : [target.url];
    for (const [index, entry] of entries.entries()) {
      const source = typeof entry === 'string'
        ? { ...target, url: entry, sourceKind: 'playlist' }
        : { ...target, ...entry, url: entry && entry.url };
      const injected = source.name === undefined
        ? { ...source, sourceKind: 'playlist' }
        : namedVideoSource(target.directory, { ...source, archive: entry.archive }, index);
      if (injected.sourceKind === 'video') {
        if (!namesByDirectory.has(target.directory)) namesByDirectory.set(target.directory, new Set());
        const names = namesByDirectory.get(target.directory);
        if (names.has(injected.name)) {
          throw new Error(`Target directory ${target.directory} contains duplicate name "${injected.name}".`);
        }
        names.add(injected.name);
      } else if (typeof injected.url !== 'string' || !injected.url.trim()) {
        throw new Error(`Target ${target.directory} URL entry ${index} must be a string or object with a url.`);
      }
      targets.push(injected);
    }
  }
  return { ...config, targets };
}

function groupSources(config) {
  const groups = new Map();
  for (const source of config.targets || []) {
    if (source.enable === 0 || source.enabled === false) continue;
    if (!groups.has(source.directory)) groups.set(source.directory, { directory: source.directory, sources: [] });
    const group = groups.get(source.directory);
    if (group.sources.some((candidate) => candidate.url === source.url)) {
      throw new Error(`Duplicate source URL in directory "${source.directory}": ${source.url}`);
    }
    group.sources.push(source);
  }
  return [...groups.values()];
}

module.exports = { groupSources, injectSources, namedVideoSource, sourceOutputTemplate, validName };
