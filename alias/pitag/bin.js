#!/usr/bin/env node
// Alias package: forwards to the real CLI from the pi-tag package.
import { runCli } from 'pi-tag/dist/cli/index.js';

await runCli();
