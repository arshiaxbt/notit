// `npm run lab`: runs the three experiments with fixed seeds, prints the tables to
// stdout and writes the same numbers to engine/out/lab.json. Deterministic: no clock,
// no Math.random — two runs produce byte-identical output.

import { mkdirSync, writeFileSync } from 'node:fs';
import { formatLab, labToJson, runLab } from './experiments.ts';

const lab = runLab();
const outDir = new URL('../out/', import.meta.url);
mkdirSync(outDir, { recursive: true });
writeFileSync(new URL('lab.json', outDir), labToJson(lab));
process.stdout.write(formatLab(lab));
