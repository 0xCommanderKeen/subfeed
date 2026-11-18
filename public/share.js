import { api, el, fill, registerServiceWorker, youtubeChannelUrl } from './dom.js';
import { parseShared } from './share-link.js';

const heading = document.getElementById('heading');
const panel = document.getElementById('shared');
const params = new URLSearchParams(location.search);
const sharedText = ['url', 'text', 'title'].map((key) => params.get(key)).filter(Boolean);
const shared = parseShared(...sharedText);

const link = (href, text, className = 'btn') => el('a', { href, className, textContent: text });
const addChannelHref = (channel, video) =>
  `manage.html?${new URLSearchParams({ add: youtubeChannelUrl(channel), ...(video && { queue: video.url }) })}`;

function show(title, ...lines) {
  heading.textContent = title;
  fill(panel, ...lines);
}

function videoLine(video) {
  return el('div', { className: 'shared-video' },
    video.thumbnail ? el('img', { src: video.thumbnail, alt: '', referrerPolicy: 'no-referrer' }) : null,
    el('p', {}, el('a', { href: video.url, target: '_blank', rel: 'noopener', textContent: video.title }),
      el('span', { className: 'muted', textContent: ` · ${video.channelName}` })));
}

function showResult({ queued, video, channel }) {
  if (!queued) {
    return show('New channel', videoLine(video),
      el('p', { className: 'muted', textContent: `${channel.name} is not in subfeed. Add the channel to put this video in Watch Later.` }),
      el('p', { className: 'actions' }, link(addChannelHref(channel, video), `Add ${channel.name}`, 'btn primary'), link(video.url, 'Watch on YouTube')));
  }
  show('Added to Watch Later', videoLine(video),
    channel.subscribed ? null : el('p', { className: 'muted', textContent: `Watch Later shows it once you subscribe to ${channel.name}.` }),
    el('p', { className: 'actions' },
      channel.subscribed ? null : link(addChannelHref(channel), `Add ${channel.name}`, 'btn primary'),
      link('./#/watch-later', 'Open Watch Later', channel.subscribed ? 'btn primary' : 'btn')));
}

async function shareVideo({ id, isShort }) {
  try {
    showResult(await api('POST', '/api/share', { url: `https://www.youtube.com/${isShort ? 'shorts/' : 'watch?v='}${id}` }));
  } catch (err) {
    show('Not added', el('p', { className: 'error', textContent: err.message }));
  }
}

if (shared?.kind === 'channel') location.replace(`manage.html?${new URLSearchParams({ add: shared.input })}`);
else if (shared?.kind === 'video') shareVideo(shared);
else {
  show('Not a YouTube link',
    el('p', { textContent: 'Share a YouTube video, a channel, or an @handle to subfeed.' }),
    sharedText.length ? el('p', { className: 'muted', textContent: sharedText.join(' ') }) : null);
}
registerServiceWorker();
