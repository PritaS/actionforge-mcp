import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const temp = mkdtempSync(join(tmpdir(), 'actionforge-package-'));
try {
  execFileSync('npm', ['run', 'build'], {stdio:'inherit'});
  execFileSync('npm', ['test'], {stdio:'inherit'});
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], {encoding:'utf8'}));
  const files = packed[0].files.map(file => file.path);
  for (const file of ['package.json','dist/server.js','dist/client.js','dist/protocol.js']) assert.ok(files.includes(file), `Missing ${file}`);
  execFileSync('tar', ['-xzf', join(temp, packed[0].filename), '-C', temp]);
  const root = join(temp, 'package');
  const manifest = JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  assert.equal(manifest.bin['actionforge-mcp'], 'dist/server.js');
  cpSync('scripts/smoke.mjs', join(root, 'smoke.mjs'));
  execFileSync(process.execPath, ['smoke.mjs'], {cwd:root, stdio:'inherit',timeout:20000});
  console.log('Packed-artifact verification passed; nothing published.');
} finally { rmSync(temp,{recursive:true,force:true}); }
