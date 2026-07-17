const fs = require('node:fs');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '..');
const summaryPath = path.resolve(backendRoot, '../coverage/coverage-summary.json');
const outputPath = path.resolve(__dirname, 'coverage-baseline.json');
const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const metrics = ['lines', 'branches', 'functions', 'statements'];
const globalSentinel = 'src/auth/app-role.enum.ts';
const uncoveredTolerance = {
  'src/health/health.service.ts': { branches: 1 },
};

const entries = Object.entries(summary)
  .filter(([file]) => file !== 'total')
  .map(([file, coverage]) => [path.relative(backendRoot, file), coverage])
  .filter(([file]) => file.startsWith('src/') || file.startsWith('cache/'))
  .filter(([file]) => file !== globalSentinel)
  .sort(([left], [right]) => left.localeCompare(right));

const baseline = entries.map(([file, coverage]) => [
  file,
  ...metrics.map(metric => {
    const uncovered = coverage[metric].total - coverage[metric].covered;
    const tolerance = uncoveredTolerance[file]?.[metric] ?? 0;
    return uncovered === 0 && tolerance === 0 ? 100 : -(uncovered + tolerance);
  }),
]);

const output = `[\n${baseline
  .map(entry => `  ${JSON.stringify(entry)}`)
  .join(',\n')}\n]\n`;

fs.writeFileSync(outputPath, output);
console.log(`Wrote a baseline for ${baseline.length} coverage files.`);
