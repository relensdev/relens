const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(__dirname, '..', 'src', 'version.ts'),
  `export const VERSION = '${pkg.version}';\n`,
  'utf8'
);
console.log(`version.ts → ${pkg.version}`);
