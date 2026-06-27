/**
 * Item 3 — build data-derived thresholds from the datasets.
 * Reads the clinical scale dataset and computes per-indicator BANDS (terciles)
 * so the rule engine's low/moderate/severe cutoffs are derived from data rather
 * than hardcoded. Writes knowledge/thresholds.json (committed); the runtime
 * never parses CSV — it loads this JSON via KB.band().
 *
 *   node scripts/buildKnowledgeBase.js
 *
 * The labels per signal encode clinical direction (e.g. higher self_esteem is
 * BETTER, so its low tercile is labelled 'low'). Re-run if the dataset changes.
 */
const fs = require('fs');
const path = require('path');

const CSV = path.join(__dirname, '..', '..', 'DATASETS-UPDATED', 'DATASETS', 'CLINICAL', 'StressLevelDataset.csv');
const OUT = path.join(__dirname, '..', 'knowledge', 'thresholds.json');

// signal name → { col, labels:[lowTercile, midTercile, highTercile] }.
// Labels are the exact vocabulary the IF-THEN rules consume.
const SIGNALS = {
  depression:     { col: 'depression',     labels: ['mild', 'moderate', 'severe'], note: 'higher = more severe' },
  anxiety_level:  { col: 'anxiety_level',  labels: ['low', 'moderate', 'severe'],  note: 'higher = more severe' },
  self_esteem:    { col: 'self_esteem',    labels: ['low', 'moderate', 'high'],    note: 'higher = better; low tercile triggers C-EF-05' },
  sleep_quality:  { col: 'sleep_quality',  labels: ['low', 'moderate', 'high'],    note: 'higher = better; low tercile triggers C-EF-04' },
  social_support: { col: 'social_support', labels: ['low', 'moderate', 'high'],    note: 'higher = better; low tercile triggers C-SF-01' },
  stress_level:   { col: 'stress_level',   labels: ['low', 'moderate', 'high'],    note: 'higher = more stress' },
};

function percentile(sorted, p) {
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx];
}

const lines = fs.readFileSync(CSV, 'utf8').split(/\r?\n/).filter(Boolean);
const header = lines[0].split(',').map((h) => h.trim());
const colIdx = (name) => header.indexOf(name);

const thresholds = {};
for (const [signal, cfg] of Object.entries(SIGNALS)) {
  const i = colIdx(cfg.col);
  if (i < 0) { console.warn(`  column not found: ${cfg.col}`); continue; }
  const vals = [];
  for (let r = 1; r < lines.length; r++) {
    const v = Number(lines[r].split(',')[i]);
    if (Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  const t1 = percentile(vals, 1 / 3);
  const t2 = percentile(vals, 2 / 3);
  thresholds[signal] = {
    source: 'StressLevelDataset.csv',
    column: cfg.col,
    note: cfg.note,
    n: vals.length,
    range: [vals[0], vals[vals.length - 1]],
    // A value v gets the label of the FIRST band whose max it does not exceed;
    // the final band (max:null) catches everything above t2.
    bands: [
      { max: t1, label: cfg.labels[0] },
      { max: t2, label: cfg.labels[1] },
      { max: null, label: cfg.labels[2] },
    ],
  };
  console.log(`  ${signal}: terciles ≤${t1} / ≤${t2} / > → ${cfg.labels.join(' / ')} (n=${vals.length}, range ${vals[0]}–${vals[vals.length - 1]})`);
}

fs.writeFileSync(OUT, JSON.stringify(thresholds, null, 2) + '\n');
console.log(`✅ thresholds.json written — ${Object.keys(thresholds).length} signals`);
