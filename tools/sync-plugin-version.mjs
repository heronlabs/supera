import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginManifest = join(repoRoot, '.claude-plugin', 'plugin.json');
const marketplaceManifest = join(repoRoot, '.claude-plugin', 'marketplace.json');

const {version} = JSON.parse(
  readFileSync(join(repoRoot, 'package.json'), 'utf8'),
);

const replaceMatchedVersion = (source, matcher, nextVersion) => {
  if (!matcher.test(source)) {
    throw new Error('No "version" field found to sync');
  }
  return source.replace(matcher, `$1${nextVersion}$2`);
};

const pluginVersionField = /("version"\s*:\s*")[^"]*(")/;
const pluginSource = readFileSync(pluginManifest, 'utf8');
writeFileSync(
  pluginManifest,
  replaceMatchedVersion(pluginSource, pluginVersionField, version),
);

const superaEntryVersion =
  /("name"\s*:\s*"supera"[\s\S]*?"version"\s*:\s*")[^"]*(")/;
const marketplaceSource = readFileSync(marketplaceManifest, 'utf8');
writeFileSync(
  marketplaceManifest,
  replaceMatchedVersion(marketplaceSource, superaEntryVersion, version),
);

console.log(`Synced plugin manifests to v${version}`);
