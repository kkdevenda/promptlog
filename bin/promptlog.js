#!/usr/bin/env node
'use strict';

// Shim for the repo checkout: the CLI lives in the skill directory, built
// from src/ by `npm run build` (see docs/DESIGN.md "Layout").
require('../skills/promptlog/scripts/promptlog.js');
