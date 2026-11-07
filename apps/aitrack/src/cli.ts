#!/usr/bin/env node
import { enableCompileCache } from 'node:module';

enableCompileCache(); // Reuses compiled code across runs; a no-op where it is unavailable or disabled.
if (process.env.NO_COLOR && process.env.FORCE_COLOR === undefined) process.env.FORCE_COLOR = '0'; // Chalk reads only this, once, on import.
const { runCli } = await import('./cli/program.js');
runCli();
