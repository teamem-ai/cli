import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const forbiddenSpecifier = /^(?:file:|workspace:|git(?:\+|:)|https?:\/\/github\.com\/)/;
const violations = [];

for (const group of dependencyGroups) {
  for (const [name, specifier] of Object.entries(manifest[group] ?? {})) {
    if (typeof specifier === 'string' && forbiddenSpecifier.test(specifier)) {
      violations.push(`package.json ${group}.${name}=${specifier}`);
    }
  }
}

const lockfile = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
for (const pattern of [
  /^\s+(?:specifier|version):\s+(?:file:|workspace:|git(?:\+|:))/m,
  /teamem-server\/packages\/schema/,
]) {
  if (pattern.test(lockfile)) {
    violations.push(`pnpm-lock.yaml matches ${pattern}`);
  }
}

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
for (const pattern of [
  /^\s+repository:\s+teamem-ai\/teamem-server\s*$/m,
  /^\s+path:\s+teamem-server\s*$/m,
]) {
  if (pattern.test(workflow)) {
    violations.push(`.github/workflows/ci.yml matches ${pattern}`);
  }
}

if (violations.length > 0) {
  console.error('Cross-repository dependency boundary violations:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log('Dependency boundary check passed.');
}
