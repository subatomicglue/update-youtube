#!/usr/bin/env node
'use strict';

const transcript = require('./lib/transcript');

if (require.main === module) process.exitCode = transcript.main(process.argv.slice(2));

module.exports = transcript;
