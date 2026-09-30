// One coverage report for everything: Node unit/db tests and browser tests (Chromium V8 coverage).
// Only the app's own source counts: app.js and src/*.js (not tests, config, or libraries).
export const coverageOptions = {
  name: 'Splitter — test coverage',
  outputDir: 'coverage',
  reports: [['v8'], ['console-details', { skipPercent: 0 }], ['json-summary'], ['lcovonly']],
  entryFilter: (entry) => /(^|\/)(app\.js|src\/[\w-]+\.js)(\?|$)/.test(entry.url) && !/node_modules|\/tests\//.test(entry.url),
  // Browser entries are served from http://localhost:<port>/...; Node entries are file paths.
  // Normalise both to "app.js" / "src/x.js" so runs of the same file merge into one row.
  sourcePath: (filePath) => {
    const p = filePath.replace(/\\/g, '/');
    const m = /(app\.js|src\/[\w-]+\.js)$/.exec(p);
    return m ? m[1] : p;
  },
  cleanCache: false,
};
