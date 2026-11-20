// Push notifications through ntfy (https://ntfy.sh), configured with NTFY_URL and NTFY_TOKEN.
import { videoUrl } from './feed.mjs';

const MAX_PER_REFRESH = 10;

// ntfy reads RFC 2047 encoded words in headers; fetch only sends Latin-1 header values.
const headerValue = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

// `send` throws when ntfy does not accept the message.
export function ntfySender({ topicUrl, token = null, fetchImpl = fetch }) {
  return async ({ title, body, click, attach, tags, priority }) => {
    const headers = { 'Content-Type': 'text/plain; charset=utf-8', Title: headerValue(title) };
    if (click) headers.Click = click;
    if (attach) headers.Attach = attach;
    if (tags) headers.Tags = tags;
    if (priority) headers.Priority = priority;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchImpl(topicUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`ntfy answered HTTP ${res.status}`);
  };
}

// Each video is marked as notified once its message is sent, so it is never announced twice. One whose message fails
// stays waiting for the next call.
export async function notifyNewUploads({ db, send }) {
  const uploads = db.uploadsToAnnounce();
  if (uploads.length > MAX_PER_REFRESH) {
    const channels = [...new Set(uploads.map((u) => u.channelName))];
    await send({ title: `${uploads.length} new videos`, body: `From ${channels.join(', ')}`, tags: 'tv' });
    db.markNotified(uploads.map((u) => u.id));
    return 1;
  }
  let sent = 0;
  for (const u of uploads) {
    try {
      await send({ title: u.channelName, body: u.title, click: videoUrl(u.id, false), attach: u.thumbnail, tags: 'tv' });
      db.markNotified([u.id]);
      sent++;
    } catch (err) {
      console.error(`ntfy: could not announce ${u.id}: ${err.message}`);
    }
  }
  return sent;
}
