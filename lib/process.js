'use strict';

const { spawnSync } = require('child_process');

const RED = '\u001b[31;1m';
const RESET = '\u001b[0m';

function errorText(text, enabled = process.stderr.isTTY) {
  return enabled ? `${RED}${text}${RESET}` : text;
}

function colorErrorLines(text, enabled = process.stderr.isTTY) {
  if (!enabled) return text;
  return String(text).split(/(\r?\n)/u)
    .map((part) => (/\bERROR\b/u.test(part) ? errorText(part, true) : part))
    .join('');
}

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
    stdio: options.capture ? 'pipe' : (options.captureStderr ? ['inherit', 'inherit', 'pipe'] : 'inherit'),
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    shell: false
  });
  if (options.captureStderr && result.stderr) process.stderr.write(colorErrorLines(result.stderr));
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

module.exports = { colorErrorLines, errorText, formatProcessError, ProcessError, run };
