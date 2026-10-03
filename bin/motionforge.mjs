#!/usr/bin/env node
// Entry point that works from any working directory (Claude Desktop, scripts, terminals).
import { register } from 'tsx/esm/api';

register();
const [cmd = 'start', ...rest] = process.argv.slice(2);
process.argv = [process.argv[0], process.argv[1], ...rest];
const target = {
  start: '../src/server/main.ts',
  serve: '../src/server/main.ts',
  mcp: '../src/mcp/stdio.ts',
  render: '../src/cli.ts',
  reindex: '../src/cli.ts',
  validate: '../src/cli.ts',
}[cmd];
if (!target) {
  console.error(`usage: motionforge <start|mcp|render <composition.json> [quality]|validate <composition.json>|reindex>`);
  process.exit(1);
}
if (target.endsWith('cli.ts')) process.argv.splice(2, 0, cmd);
await import(new URL(target, import.meta.url).href);
