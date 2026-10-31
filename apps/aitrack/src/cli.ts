#!/usr/bin/env node
import { enableCompileCache } from 'node:module';

enableCompileCache(); // Reuses compiled code across runs; a no-op where it is unavailable or disabled.
const { buildProgram } = await import('./cli/program.js');
buildProgram().parse();
