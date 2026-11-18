// The in-page player: a YouTube embed over the page, from youtube-nocookie.com through the IFrame Player API.
import { el, fill, icon } from './dom.js';
import { errorText, mostlyPlayed, positionToSave, stepFrom, youtubeUrl } from './playback.js';

let ytApi = null;
function loadYouTube() {
  ytApi ??= new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const script = el('script', { src: 'https://www.youtube.com/iframe_api' });
    script.onerror = () => {
      script.remove();
      ytApi = null;
      reject(new Error('The YouTube player did not load.'));
    };
    document.head.append(script);
  });
  return ytApi;
}

// The page behind the overlay; the toast stays reachable for Undo.
const behind = () => document.querySelectorAll('#nav, #nav-backdrop, header.top, .page');

// The one player on the page. Opening a video while the mini player plays replaces it.
let current = null;

/**
 * Plays `videos[index]`. With `playThrough`, an ended video moves on to the next one, and the player shows
 * Previous and Next.
 * - `onWatched(v)` runs once most of a video has played, and when it opens on YouTube from the player.
 * - `onDone(v)` runs when a video ends, and when it opens on YouTube from the player.
 * - `onPosition(v, seconds)` runs when the place to resume `v` changes: whole seconds, or null to forget it. The player
 *   checks every 15 seconds of play, and whenever it stops, leaves the video, or the page hides.
 * Each video starts at its saved `position`.
 * A click beside the player, or a step back in history, shrinks it to a mini player in the corner that keeps playing
 * while the page works again. The mini player only restyles the overlay: moving the embed would reload it.
 */
export function openPlayer(videos, index, { playThrough = false, onWatched, onDone = () => {}, onPosition }) {
  current?.close();
  let i = index;
  let mini = false;
  let yt = null;
  let ready = false;
  // Until the video plays, the player reports 0 or the last video's time, which would overwrite its saved place.
  let started = false;
  let polling = null;
  const returnTo = document.activeElement;
  const video = () => videos[i];

  const mount = el('div', {});
  const failure = el('div', { className: 'player-error', hidden: true });
  const frame = el('div', { className: 'player-frame' }, mount, failure);
  const title = el('h2', {});
  const facts = el('p', {});
  const prev = el('button', { type: 'button', className: 'icon-btn', title: 'Previous', ariaLabel: 'Previous video', onclick: () => step(-1) }, icon('back'));
  const next = el('button', { type: 'button', className: 'icon-btn', title: 'Next', ariaLabel: 'Next video', onclick: () => step(1) }, icon('arrow'));
  const youtube = el('button', { type: 'button', className: 'pill-btn', onclick: openOnYouTube }, icon('external'), 'Open on YouTube');
  const sizeBtn = el('button', { type: 'button', className: 'icon-btn', onclick: () => setMini(!mini) });
  const closeBtn = el('button', { type: 'button', className: 'icon-btn', title: 'Close (Esc)', ariaLabel: 'Close the player', onclick: close }, icon('close'));
  const box = el('div', { className: 'player-box' }, frame,
    el('div', { className: 'player-bar' },
      el('div', { className: 'player-text', onclick: () => mini && setMini(false) }, title, facts),
      playThrough ? prev : null, playThrough ? next : null, youtube, sizeBtn, closeBtn));
  const overlay = el('div', { className: 'player', role: 'dialog', ariaLabel: 'Video player' },
    el('div', { className: 'player-backdrop', onclick: () => setMini(true) }), box);

  // The page's own shortcuts, such as / for search, wait while the player fills the page.
  function onKey(e) {
    e.stopImmediatePropagation();
    if (e.key !== 'Escape') return;
    e.preventDefault();
    close();
  }

  const shrink = () => setMini(true);

  function setMini(on) {
    mini = on;
    overlay.classList.toggle('mini', on);
    overlay.ariaModal = String(!on);
    for (const node of behind()) node.inert = !on;
    document.documentElement.classList.toggle('playing', !on);
    fill(sizeBtn, icon(on ? 'expand' : 'mini'));
    sizeBtn.title = on ? 'Expand' : 'Mini player';
    sizeBtn.ariaLabel = on ? 'Expand the player' : 'Shrink to the mini player';
    if (on) {
      removeEventListener('keydown', onKey, true);
      removeEventListener('popstate', shrink);
      if (overlay.contains(document.activeElement)) returnTo?.focus?.({ preventScroll: true });
    } else {
      addEventListener('keydown', onKey, true);
      addEventListener('popstate', shrink);
      closeBtn.focus({ preventScroll: true });
    }
  }

  function showFailure(text) {
    clearInterval(polling);
    fill(failure, el('p', { textContent: text }), el('button', { type: 'button', className: 'pill-btn', onclick: openOnYouTube }, icon('external'), 'Open on YouTube'));
    failure.hidden = false;
  }

  function show() {
    const v = video();
    box.classList.toggle('short', v.isShort);
    title.textContent = v.title;
    facts.textContent = playThrough ? `${v.channelName} · ${i + 1} of ${videos.length}` : v.channelName;
    prev.disabled = stepFrom(videos, i, -1) < 0;
    next.disabled = stepFrom(videos, i, 1) < 0;
    failure.hidden = true;
    started = false;
    if (ready) load(v);
  }

  const load = (v) => yt.loadVideoById({ videoId: v.id, startSeconds: v.position ?? 0 });

  function savePosition() {
    if (!started) return;
    const v = video();
    const at = positionToSave(v, yt.getCurrentTime(), yt.getDuration());
    if (at !== (v.position ?? null)) onPosition(v, at);
  }

  const savePositionIfHidden = () => document.visibilityState === 'hidden' && savePosition();

  function step(dir) {
    const to = stepFrom(videos, i, dir);
    if (to < 0) return false;
    savePosition();
    i = to;
    show();
    return true;
  }

  function watchProgress() {
    clearInterval(polling);
    let seconds = 0;
    polling = setInterval(() => {
      if (mostlyPlayed(video(), yt.getCurrentTime(), yt.getDuration())) {
        clearInterval(polling);
        onWatched(video());
        savePosition();
      } else if (++seconds % 15 === 0) savePosition();
    }, 1000);
  }

  function onStateChange({ data }) {
    const { PLAYING, PAUSED, ENDED } = window.YT.PlayerState;
    if (data === PLAYING) {
      started = true;
      watchProgress();
    } else clearInterval(polling);
    if (data === PAUSED || data === ENDED) savePosition();
    if (data !== ENDED) return;
    const v = video();
    onWatched(v);
    onDone(v);
    if (playThrough && !step(1)) close();
  }

  function openOnYouTube() {
    const v = video();
    const at = ready ? yt.getCurrentTime() : 0;
    savePosition();
    if (ready) yt.pauseVideo();
    window.open(youtubeUrl(v, at), '_blank', 'noopener');
    onWatched(v);
    onDone(v);
  }

  function close() {
    if (!mini) setMini(true);
    clearInterval(polling);
    savePosition();
    started = false;
    removeEventListener('pagehide', savePosition);
    document.removeEventListener('visibilitychange', savePositionIfHidden);
    yt?.destroy();
    yt = null;
    overlay.remove();
    if (current?.close === close) current = null;
  }

  current = { close };
  addEventListener('pagehide', savePosition);
  document.addEventListener('visibilitychange', savePositionIfHidden);
  document.body.append(overlay);
  setMini(false);
  show();

  loadYouTube().then((YT) => {
    if (!overlay.isConnected) return;
    const first = video();
    yt = new YT.Player(mount, {
      host: 'https://www.youtube-nocookie.com',
      videoId: first.id,
      width: '100%',
      height: '100%',
      playerVars: { autoplay: 1, playsinline: 1, rel: 0, origin: location.origin, start: first.position ?? 0 },
      events: {
        // Previous or Next before the player was ready only moved `i`.
        onReady: () => {
          ready = true;
          if (video().id !== first.id) load(video());
        },
        onStateChange,
        onError: ({ data }) => showFailure(errorText(data)),
      },
    });
  }, (err) => showFailure(err.message));
}
