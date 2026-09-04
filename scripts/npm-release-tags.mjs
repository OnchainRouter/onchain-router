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

export function retiredTagCleanup(tags, version) {
  if (tags.latest !== version)
    throw new Error(
      `latest dist-tag must resolve to ${version}, found ${tags.latest ?? 'missing'}`,
    );
  return tags.alpha ? ['alpha'] : [];
}

export function releaseAuthentication(environment) {
  if (environment.ACTIONS_ID_TOKEN_REQUEST_URL && environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
    return 'trusted-publishing';
  if (environment.NODE_AUTH_TOKEN) return 'repository-token';
  throw new Error('stable publication requires npm trusted publishing or a repository token');
}
