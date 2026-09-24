'use strict';

const { spawnSync } = require('child_process');

class ProcessError extends Error {
  constructor(command, status, options, stderr) {
    super(`${options.errorLabel || command} exited with status ${status}`);
    this.name = 'ProcessError';
    this.status = status;
    this.stderr = stderr || '';
    this.outputDisplayed = !options.capture;
  }
}

function run(command, args, options = {}) {
  const printable = [command, ...args].map(quote).join(' ');
  if (!options.quiet) console.log(`> ${printable}`);
  if (options.simulate) return { status: 0 };
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new ProcessError(command, result.status, options, result.stderr);
  }
  return result;
}

function formatProcessError(error) {
  return error instanceof ProcessError && error.stderr.trim()
    ? error.stderr.trim()
    : error.message;
}

function quote(value) {
  const text = String(value);
  return /[\s"']/u.test(text) ? JSON.stringify(text) : text;
}

module.exports = { formatProcessError, ProcessError, run };
