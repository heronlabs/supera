import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

const repoRoot = join(__dirname, '..');
const readJson = (...segments: string[]) =>
  JSON.parse(readFileSync(join(repoRoot, ...segments), 'utf8'));

describe('version lockstep', () => {
  it('keeps plugin.json version in step with package.json', () => {
    const packageVersion = readJson('package.json').version;
    const pluginVersion = readJson('.claude-plugin', 'plugin.json').version;
    expect(pluginVersion).toBe(packageVersion);
  });

  it('keeps the marketplace supera entry in step with plugin.json', () => {
    const pluginVersion = readJson('.claude-plugin', 'plugin.json').version;
    const marketplace = readJson('.claude-plugin', 'marketplace.json');
    const superaEntry = marketplace.plugins.find(
      (entry: {name: string}) => entry.name === 'supera',
    );
    expect(superaEntry.version).toBe(pluginVersion);
  });
});
