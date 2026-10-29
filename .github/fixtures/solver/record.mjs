// Refresh the small offline corpus. Run manually; tests never use the network.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const selections = {
  'fabric-api': ['bK6OgzFj', 'Zp9iAZdZ'],
  'ferrite-core': ['sOzRw3CG'],
  lithium: ['N08Z8wog'],
  'cloth-config': ['7jtvrmVP'],
  waystones: ['pCpQ1Jxr', 'nSAwjAk4'],
  balm: ['Pz0YXByM', 'EghJxg4h'],
};
const get = async (url) => {
  const response = await fetch(url, { headers: { 'user-agent': 'spawnpoint-solver-fixtures/1.0 (github.com/vayungodara/spawnpoint)' } });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response;
};
const extract = (buffer) => {
  const zip = new AdmZip(buffer);
  const fabric = JSON.parse(zip.readAsText('fabric.mod.json'));
  return {
    fabric,
    nested: Object.fromEntries((fabric.jars ?? []).map(({ file }) => [file, extract(zip.readFile(file))])),
  };
};
const versions = [], jars = {};
for (const [project, ids] of Object.entries(selections)) {
  for (const id of ids) {
    const version = await (await get(`https://api.modrinth.com/v2/version/${id}`)).json();
    versions.push(version); // Unmodified real Modrinth response.
    const file = version.files.find((f) => f.primary) ?? version.files[0];
    const bytes = Buffer.from(await (await get(file.url)).arrayBuffer());
    if (createHash('sha1').update(bytes).digest('hex') !== file.hashes.sha1) throw new Error(`Checksum mismatch: ${id}`);
    jars[id] = extract(bytes); // Unmodified fabric.mod.json, recursively by declared jar path.
    console.log(`${project}: ${id} (${file.filename})`);
  }
}
writeFileSync(fileURLToPath(new URL('recorded.json', import.meta.url)), `${JSON.stringify({
  recordedAt: new Date().toISOString(),
  source: 'https://api.modrinth.com/v2/version/{id}; jars at versions[].files[].url, SHA-1 verified before extraction',
  versions, jars,
}, null, 2)}\n`);
