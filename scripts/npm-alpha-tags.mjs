export function parseDistTags(output) {
  const tags = {};
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const tag = line.slice(0, separator).trim();
    const version = line.slice(separator + 1).trim();
    if (tag && version) tags[tag] = version;
  }
  return tags;
}

export function alphaTagCleanup(tags, version) {
  if (tags.alpha !== version)
    throw new Error(`alpha dist-tag must resolve to ${version}, found ${tags.alpha ?? 'missing'}`);
  return tags.latest === version ? ['latest'] : [];
}
