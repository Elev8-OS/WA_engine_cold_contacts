#!/usr/bin/env node
/**
 * Rotation trocken prüfen — ohne echte DB, ohne API.
 *
 *   node scripts/simulate.js 40
 *
 * Zeigt die Verteilung über den Pool und die längste Wiederholungsserie.
 * Erwartung: gleichmässige Verteilung, längste Serie = 1.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const count = Number(process.argv[2] || 40);
const step = Number(process.argv[3] || 1);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rotator-sim-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'simulation-key-000000';
process.env.DRY_RUN = 'true';

const { upsertVariants, pickVariant, markVariantSent, render, poolStats } = await import('../src/pool.js');

const poolFile = path.resolve(process.cwd(), 'pool.json');
const list = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
upsertVariants(Array.isArray(list) ? list : list.variants);

const sequence = [];
for (let i = 0; i < count; i++) {
  const v = pickVariant(step);
  if (!v) {
    console.error(`Keine aktive Variante für Step ${step}.`);
    process.exit(1);
  }
  markVariantSent(v.id);
  sequence.push(v.id);
}

let longestRun = 1;
let run = 1;
for (let i = 1; i < sequence.length; i++) {
  run = sequence[i] === sequence[i - 1] ? run + 1 : 1;
  if (run > longestRun) longestRun = run;
}

console.log(`\n${count} Sends simuliert, Step ${step}\n`);
console.log('Verteilung:');
for (const v of poolStats().filter((v) => v.step === step)) {
  const share = ((v.sent_count / count) * 100).toFixed(1);
  console.log(`  ${v.id.padEnd(14)} ${String(v.sent_count).padStart(3)}  ${share.padStart(5)}%  ${'█'.repeat(v.sent_count)}`);
}
console.log(`\nLängste Wiederholungsserie: ${longestRun}  ${longestRun === 1 ? '✓' : '← sollte 1 sein'}`);
console.log(`\nReihenfolge:\n  ${sequence.join(' → ')}`);

const raw = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
const sample = (Array.isArray(raw) ? raw : raw.variants).find((v) => (v.step ?? 1) === step);
if (sample) {
  console.log('\nBeispiel-Rendering:');
  console.log(`  ${render(sample.body, { first_name: 'Made' })}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
