// The page's address. No DOM here, so the tests import it directly.
// Routes are #/<group>, #/<group>/channel/<id> and #/<group>/search/<text>; a search covers its group.
export function hashOf({ group, channelId, q }) {
  if (q) return `#/${group.id}/search/${encodeURIComponent(q)}`;
  return `#/${group.id}${channelId ? `/channel/${channelId}` : ''}`;
}

function decoded(text) {
  try {
    return decodeURIComponent(text ?? '').trim() || null;
  } catch {
    return null;
  }
}

// A group the meta lacks falls back to `savedGroupId`, then the first group; a channel it lacks, to its group.
export function routeOf(hash, groups, channelsById, savedGroupId) {
  const [groupId, kind, arg] = hash.replace(/^#\/?/, '').split('/');
  const group = groups.find((g) => g.id === groupId) ?? groups.find((g) => g.id === savedGroupId) ?? groups[0];
  return { group, channelId: kind === 'channel' && channelsById.has(arg) ? arg : null, q: kind === 'search' ? decoded(arg) : null };
}
