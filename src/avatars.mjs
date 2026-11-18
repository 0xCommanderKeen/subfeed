// Channels added before avatars were stored get theirs during refreshes, a few at a time.
import { fetchChannelPage, lookupChannels, parseChannelPage } from './resolve.mjs';
import { MAX_PER_CALL } from './youtube-api.mjs';

// Without a key each channel costs a page load from youtube.com.
export const AVATAR_PAGES_PER_REFRESH = 10;

export async function fillMissingAvatars({ db, api = null, fetchImpl }) {
  if (api) {
    const ids = db.channelsMissingAvatar(MAX_PER_CALL);
    if (!ids.length) return 0;
    const found = await lookupChannels(ids, api);
    db.setAvatars(ids.map((id) => ({ id, avatar: found.get(id)?.avatar ?? null })));
    return ids.length;
  }
  const avatars = [];
  for (const id of db.channelsMissingAvatar(AVATAR_PAGES_PER_REFRESH)) {
    try {
      const html = await fetchChannelPage({ kind: 'id', id }, fetchImpl);
      if (html === null) {
        avatars.push({ id, avatar: null });
        continue;
      }
      // A consent or error page names no channel; leave the avatar unknown and try again next refresh.
      const channel = parseChannelPage(html, { kind: 'id', id });
      if (channel) avatars.push({ id, avatar: channel.avatar });
    } catch (err) {
      console.warn(`avatar of ${id}: ${err.message}`);
    }
  }
  db.setAvatars(avatars);
  return avatars.length;
}
