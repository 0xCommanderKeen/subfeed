import { DEFAULT_INACTIVE_DAYS, INACTIVE_PERIODS, backfilling, lastUploadText, shownChannels, stopBackfillQuestion, tickedChannels } from './activity.js';
import { api, channelHead, channelLink, el, failed, fill, finePointer, icon, prefs, registerServiceWorker, starButton, toast, topicPicker } from './dom.js';
import { buildGroups, visibleCount } from './groups.js';
import { mountImport } from './import.js';
import { mountNav } from './sidebar.js';
import { sortable } from './sortable.js';
import { plural, whole } from './vocab.js';

const POLL_MS = 1500;
const NO_TOPIC = '';
const CLOSED = { kind: 'none' };
const dayTime = new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

const state = {
  data: null,
  meta: null,
  filter: '',
  // 'all' lists channels by topic; 'inactive' lists subscribed channels with no upload in inactiveDays.
  view: 'all',
  inactiveDays: prefs.get('manage.inactiveDays', DEFAULT_INACTIVE_DAYS),
  // At most one inline editor or confirmation is open:
  // CLOSED ({ kind: 'none' }) | { kind: 'topics' | 'delete', channelId, group } | { kind: 'rename-topic', topicId, draft } | { kind: 'delete-topic', topicId }
  ui: CLOSED,
  // The channel the add form last added, shown with live counts and backfill state.
  added: null,
  addError: '',
  adding: false,
  addTopics: new Set(),
  // A video shared to subfeed whose channel was not in it yet: its URL, to put in Watch Later once the add succeeds.
  pendingVideo: null,
  // Ticked channel ids, kept across filter changes, and the topic the bulk bar adds or removes.
  selected: new Set(),
  bulkTopic: '',
  // What the last bulk change did, until the selection changes.
  bulkResult: '',
  rules: [],
};

const els = {
  summary: document.getElementById('summary'),
  notice: document.getElementById('notice'),
  addForm: document.getElementById('add-form'),
  addInput: document.getElementById('add-input'),
  addTopics: document.getElementById('add-topics'),
  addButton: document.getElementById('add-button'),
  addResult: document.getElementById('add-result'),
  topics: document.getElementById('topic-list'),
  topicForm: document.getElementById('topic-form'),
  topicInput: document.getElementById('topic-input'),
  filter: document.getElementById('filter'),
  tools: document.getElementById('channel-tools'),
  bulk: document.getElementById('bulk'),
  channels: document.getElementById('channel-groups'),
  rules: document.getElementById('rule-list'),
  ruleForm: document.getElementById('rule-form'),
  importFile: document.getElementById('import-file'),
  importFileName: document.getElementById('import-file-name'),
  youtubePanel: document.getElementById('youtube-panel'),
  youtubeStatus: document.getElementById('youtube-status'),
};

const topicName = (id) => state.data.topics.find((t) => t.id === id)?.name ?? id;
const channelById = (id) => state.data.channels.find((c) => c.id === id);
const countsText = (c) => `${plural(visibleCount(c.counts, true), 'video')} · ${whole.format(c.counts.short)} Shorts`;

function setUi(ui) {
  state.ui = ui;
  render();
}

const nav = mountNav({
  nav: document.getElementById('nav'),
  opener: document.getElementById('nav-open'),
  backdrop: document.getElementById('nav-backdrop'),
  managing: true,
  onFilterChange: () => renderNav(),
  onRefresh: async () => {
    nav.setRefreshing(true);
    try {
      await api('POST', '/api/refresh');
      await load();
    } catch (err) {
      failed(`Could not refresh: ${err.message}`);
    } finally {
      nav.setRefreshing(false);
    }
  },
});
const fileImport = mountImport({ root: document.getElementById('import-review'), source: 'csv', topics: () => state.data.topics, onChange: () => load() });
const youtubeImport = mountImport({ root: document.getElementById('youtube-review'), source: 'youtube', topics: () => state.data.topics, onChange: () => load() });
els.importFile.addEventListener('change', async () => {
  const file = els.importFile.files[0];
  if (!file) return;
  els.importFileName.textContent = file.name;
  await fileImport.open(async () => api('POST', '/api/import/preview', { csv: await file.text() }));
  els.importFile.value = '';
});
const renderNav = () => state.meta && nav.render({ groups: buildGroups(state.meta), meta: state.meta, current: null });

let made = 0;
let pending = 0;
let changes = Promise.resolve();

// A load drops its answer when a change was made after it began or is still waiting for the server, since it would
// draw over what the change shows. The reload after the last change draws instead.
async function load(draw = render) {
  const began = made;
  const answer = await Promise.all([api('GET', '/api/channels'), api('GET', '/api/meta'), api('GET', '/api/rules')]);
  if (pending || made !== began) return;
  [state.data, state.meta, { rules: state.rules }] = answer;
  els.notice.textContent = '';
  draw();
}

// Changes go to the server one at a time, in the order they were made, and the list reloads once the last is done.
// `apply` shows the change at once, so a second click reads what the first one did. An error goes to the toast, and
// the reload puts the list back as the server has it.
function mutate(request, apply = null) {
  made += 1;
  if (apply) {
    apply();
    render();
  }
  pending += 1;
  changes = changes.then(async () => {
    try {
      await request();
    } catch (err) {
      failed(err.message);
    }
    pending -= 1;
    if (!pending) await load().catch((err) => (els.notice.textContent = `Could not reload channels: ${err.message}`));
  });
}

const patchChannel = (c, change) => mutate(() => api('PATCH', `/api/channels/${c.id}`, change), () => Object.assign(c, change));

// Unsubscribing is undone by resubscribing, so it asks first only when it would stop a backfill, which resubscribing
// does not start again. Returns whether it went ahead.
function unsubscribe(channels, text) {
  const stopping = channels.filter(backfilling);
  if (stopping.length && !confirm(stopBackfillQuestion(stopping))) return false;
  for (const c of channels) state.selected.delete(c.id);
  const send = (list, subscribed) => mutate(async () => {
    for (const [i, c] of list.entries()) {
      try {
        await api('PATCH', `/api/channels/${c.id}`, { subscribed });
      } catch (err) {
        const done = list.slice(0, i);
        if (subscribed || !done.length) throw err;
        return toast(`Unsubscribed from ${plural(done.length, 'channel')}, then could not unsubscribe from ${c.name}: ${err.message}`, { error: true, undo: () => send(done, true) });
      }
    }
  }, () => list.forEach((c) => ((channelById(c.id) ?? c).subscribed = subscribed)));
  send(channels, false);
  toast(text, { undo: () => send(channels, true) });
  return true;
}

// A backfill's progress shows in the summary, the add result and the channel rows, so a poll redraws only those and
// leaves an open select or a half-typed name alone.
let pollTimer = null;
function schedulePoll() {
  clearTimeout(pollTimer);
  if (!state.data.channels.some(backfilling)) return;
  pollTimer = setTimeout(() => load(renderProgress).catch(() => schedulePoll()), POLL_MS);
}

// Re-rendering replaces nodes; put focus back on the control that had it.
function redraw(...parts) {
  const focusKey = document.activeElement?.dataset?.key;
  for (const part of parts) part();
  if (focusKey) document.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
  schedulePoll();
}

const render = () => redraw(renderSummary, renderAddTopics, renderAddResult, renderYoutube, renderTopics, renderRules, renderTools, renderChannels, renderNav, fileImport.render, youtubeImport.render);
const renderProgress = () => redraw(renderSummary, renderAddResult, renderChannels);

// `key` names the button for render() to put focus back on. Other props go to el as they are.
function button(label, onclick, { key, ...props } = {}) {
  return el('button', { type: 'button', className: 'btn', textContent: label, onclick, dataset: key && { key }, ...props });
}

function renderSummary() {
  const { channels, apiUnits, backfillAvailable } = state.data;
  const subscribed = channels.filter((c) => c.subscribed).length;
  const parts = [plural(subscribed, 'subscribed channel'), `${channels.length - subscribed} unsubscribed`];
  parts.push(backfillAvailable ? `${plural(apiUnits, 'API unit')} used since the server started` : 'no YouTube API key: new channels get RSS videos only');
  const paused = channels.find((c) => c.backfillDetail?.pausedUntil);
  if (paused) parts.push(`backfills paused for the daily API quota, continuing ${dayTime.format(new Date(paused.backfillDetail.pausedUntil))}`);
  els.summary.textContent = parts.join(' · ');
}

// The YouTube panel shows only when the server checks the owner's subscriptions. A failed check keeps the last count.
function youtubeCount({ newChannels, checkedAt, error }) {
  const line = (textContent, className = '') => el('p', { className, textContent });
  if (!checkedAt) return line('subfeed reads your YouTube subscriptions at the next refresh.', 'muted');
  if (newChannels) {
    return el('div', { className: 'pick' },
      line(`${plural(newChannels, 'channel')} you subscribe to on YouTube ${newChannels === 1 ? 'is' : 'are'} not in subfeed.`),
      button('Review', () => youtubeImport.open(() => api('POST', '/api/youtube-subscriptions/preview')), { key: 'youtube-review', className: 'btn primary' }));
  }
  return error ? null : line('Every channel you subscribe to on YouTube is in subfeed.');
}

function renderYoutube() {
  const subs = state.meta.youtubeSubscriptions;
  els.youtubePanel.hidden = !subs;
  if (!subs) return;
  fill(els.youtubeStatus,
    youtubeCount(subs),
    subs.error ? el('p', { className: 'muted', textContent: `The last check did not work: ${subs.error}` }) : null,
    subs.checkedAt ? el('p', { className: 'muted', textContent: `Checked ${dayTime.format(new Date(subs.checkedAt))}.` }) : null);
}

function renderAddTopics() {
  for (const id of state.addTopics) if (!state.data.topics.some((t) => t.id === id)) state.addTopics.delete(id);
  fill(els.addTopics, ...topicPicker(state.data.topics, state.addTopics, (id) => {
    if (state.addTopics.has(id)) state.addTopics.delete(id);
    else state.addTopics.add(id);
    renderAddTopics();
  }, 'add-topic'));
}

function backfillText(c) {
  const d = c.backfillDetail;
  switch (c.backfill) {
    case 'queued':
      return 'Backfill queued: it starts when the backfills before it finish';
    case 'running':
      if (d.pausedUntil) {
        return `Backfill paused for the daily API quota: ${plural(visibleCount(c.counts, false), 'video')} stored so far, continues ${dayTime.format(new Date(d.pausedUntil))}`;
      }
      return `Backfill running: ${plural(visibleCount(c.counts, false), 'video')} stored so far, ${plural(d.units, 'API unit')}`;
    case 'done':
      return `Backfill done: ${whole.format(d.long)} long videos and ${whole.format(d.short)} Shorts from the API (${plural(d.units, 'unit')})`;
    case 'error':
      return `Backfill failed: ${d.error}`;
    default:
      return '';
  }
}

function renderAddResult() {
  if (state.adding) return fill(els.addResult, el('p', { className: 'muted', textContent: 'Looking up the channel and reading its feeds…' }));
  if (state.addError) return fill(els.addResult, el('p', { className: 'error', textContent: state.addError }));
  const c = state.added && channelById(state.added.id);
  if (!c) return fill(els.addResult);
  const verb = state.added.created ? 'Added' : state.added.wasSubscribed ? 'Already subscribed to' : 'Resubscribed to';
  const lines = [
    el('p', {}, `${verb} `, channelLink(c), c.handle ? el('span', { className: 'muted', textContent: ` ${c.handle}` }) : null),
    el('p', { className: 'muted', textContent: `${countsText(c)} stored · topics: ${c.topics.map(topicName).join(', ') || 'none'}` }),
  ];
  const { queued, queueError } = state.added;
  if (queued) lines.push(el('p', {}, 'Added ', el('a', { href: queued.url, target: '_blank', rel: 'noopener', textContent: queued.title }), ' to ', el('a', { href: './#/watch-later', textContent: 'Watch Later' })));
  if (queueError) lines.push(el('p', { className: 'error', textContent: queueError }));
  const backfill = backfillText(c);
  if (backfill) lines.push(el('p', { className: c.backfill === 'error' ? 'error' : 'muted', textContent: backfill }));
  else if (state.added.created && !state.data.backfillAvailable) lines.push(el('p', { className: 'muted', textContent: 'Older videos need a backfill, which needs YOUTUBE_API_KEY (see the README).' }));
  fill(els.addResult, el('div', { className: 'result' }, ...lines));
}

els.addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = els.addInput.value.trim();
  if (!input || state.adding) return;
  const existing = state.data.channels;
  state.adding = true;
  state.addError = '';
  els.addButton.disabled = true;
  render();
  try {
    const { created, channel } = await api('POST', '/api/channels', { input, topics: [...state.addTopics] });
    const before = existing.find((c) => c.id === channel.id);
    state.added = { id: channel.id, created, wasSubscribed: Boolean(before?.subscribed) };
    els.addInput.value = '';
    if (state.pendingVideo) await queueSharedVideo();
  } catch (err) {
    state.addError = err.message;
  } finally {
    state.adding = false;
    els.addButton.disabled = false;
    await load();
  }
});

// A poll redraws no topic rows, so `t` may be an object from before the last reload; the change finds it by id.
const moveTopic = (t, position) => mutate(() => api('PATCH', `/api/topics/${t.id}`, { position }), () => {
  const { topics } = state.data;
  topics.splice(position, 0, ...topics.splice(topics.findIndex((x) => x.id === t.id), 1));
});
const hideTopic = (t, hidden) => mutate(() => api('PATCH', `/api/topics/${t.id}`, { hidden }), () => (state.data.topics.find((x) => x.id === t.id).hidden = hidden));

const iconButton = (name, label, onClick, { key, disabled = false }) =>
  el('button', { type: 'button', className: 'icon-btn', title: label, ariaLabel: label, disabled, onclick: onClick, dataset: { key } }, icon(name));

// Rows move with the arrows, or by drag where there is a mouse. The drop sends the one move that put the row there.
const topicList = sortable(els.topics, {
  onMove: (row, { position }) => {
    const topic = state.data.topics.find((t) => t.id === row.dataset.topic);
    if (topic) moveTopic(topic, position);
    else renderTopics();
  },
  onSettle: () => renderTopics(),
});

async function queueSharedVideo() {
  try {
    const { queued, video } = await api('POST', '/api/share', { url: state.pendingVideo });
    if (!queued) return;
    state.added.queued = video;
    state.pendingVideo = null;
  } catch (err) {
    state.added.queueError = `Could not add the shared video to Watch Later: ${err.message}`;
  }
}

function renderTopics() {
  const { ui } = state;
  const usage = (id) => state.data.channels.filter((c) => c.topics.includes(id)).length;
  const last = state.data.topics.length - 1;
  topicList.fill(
    ...state.data.topics.map((t, i) => {
      if (ui.kind === 'rename-topic' && ui.topicId === t.id) {
        const input = el('input', { type: 'text', value: ui.draft, maxLength: 60, ariaLabel: `New name for ${t.name}`, dataset: { key: `rename-${t.id}` } });
        input.addEventListener('input', () => (ui.draft = input.value));
        const save = () => mutate(async () => {
          await api('PATCH', `/api/topics/${t.id}`, { name: input.value });
          state.ui = CLOSED;
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') setUi(CLOSED);
        });
        queueMicrotask(() => document.activeElement?.dataset?.key !== input.dataset.key && input.focus());
        return el('li', { className: 'topic-row' }, input,
          el('span', { className: 'actions' }, button('Save', save, { className: 'btn primary', key: `rename-save-${t.id}` }), button('Cancel', () => setUi(CLOSED))));
      }
      if (ui.kind === 'delete-topic' && ui.topicId === t.id) {
        const n = usage(t.id);
        return el('li', { className: 'topic-row confirm' },
          el('span', { textContent: `Delete topic ${t.name}? ${n ? `Its ${plural(n, 'channel')} stay subscribed.` : 'No channels use it.'}` }),
          el('span', { className: 'actions' },
            button('Delete topic', () => mutate(() => api('DELETE', `/api/topics/${t.id}`), () => (state.ui = CLOSED)), { className: 'btn danger', key: `delete-topic-confirm-${t.id}` }),
            button('Cancel', () => setUi(CLOSED), { key: `delete-topic-cancel-${t.id}` })));
      }
      const row = el('li', { className: `topic-row${t.hidden ? ' hidden-topic' : ''}`, dataset: { topic: t.id } },
        el('span', { className: 'grip', ariaHidden: 'true' }, icon('grip')),
        el('span', { className: 'topic-name' }, t.name,
          el('span', { className: 'muted', textContent: `${plural(usage(t.id), 'channel')}${t.hidden ? ' · in More, not in the sidebar list' : ''}` })),
        el('span', { className: 'actions' },
          iconButton('up', `Move ${t.name} up`, () => moveTopic(t, i - 1), { key: `topic-up-${t.id}`, disabled: i === 0 }),
          iconButton('down', `Move ${t.name} down`, () => moveTopic(t, i + 1), { key: `topic-down-${t.id}`, disabled: i === last }),
          button(t.hidden ? 'Show' : 'Hide', () => hideTopic(t, !t.hidden), {
            ariaLabel: `${t.hidden ? 'Show' : 'Hide'} ${t.name}`, key: `topic-hidden-${t.id}`, ariaPressed: String(t.hidden), title: t.hidden ? `Show ${t.name} in the sidebar list` : `Move ${t.name} to the sidebar's More fold`,
          }),
          button('Rename', () => setUi({ kind: 'rename-topic', topicId: t.id, draft: t.name }), { key: `rename-open-${t.id}`, ariaLabel: `Rename ${t.name}` }),
          button('Delete', () => setUi({ kind: 'delete-topic', topicId: t.id }), { key: `delete-topic-${t.id}`, ariaLabel: `Delete ${t.name}` })));
      if (finePointer()) row.draggable = true;
      topicList.attach(row);
      return row;
    }),
  );
}

// The input empties at once, so a second Enter has nothing to send again. A failure puts the text back.
function sendInput(input, path, bodyOf) {
  const text = input.value;
  if (!text.trim()) return;
  const payload = bodyOf(text);
  input.value = '';
  mutate(() => api('POST', path, payload).catch((err) => {
    input.value ||= text;
    throw err;
  }));
}

els.topicForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendInput(els.topicInput, '/api/topics', (text) => ({ name: text.trim() }));
});

function ruleText(r) {
  const pattern = `“${r.pattern}”`;
  if (r.kind === 'route') return `Route ${channelById(r.channelId).name} into ${topicName(r.topicId)} only for ${pattern}`;
  const scope = [r.channelId && `from ${channelById(r.channelId).name}`, r.topicId && `in ${topicName(r.topicId)}`].filter(Boolean);
  return `Mute ${pattern} ${scope.length ? scope.join(' ') : 'everywhere'}`;
}

const ruleInputs = {
  kind: el('select', { ariaLabel: 'Rule kind' }, el('option', { value: 'mute', textContent: 'Mute' }), el('option', { value: 'route', textContent: 'Route' })),
  pattern: el('input', { type: 'text', placeholder: 'Words in the title, like Paint Table', ariaLabel: 'Words in the title', maxLength: 100 }),
  channel: el('select', { ariaLabel: 'Channel' }),
  topic: el('select', { ariaLabel: 'Group' }),
};
fill(els.ruleForm, ruleInputs.pattern, ruleInputs.kind, ruleInputs.channel, ruleInputs.topic, el('button', { className: 'btn', type: 'submit', textContent: 'Add rule' }));
// A route needs a channel and a group, so its selects drop the "any" choice.
ruleInputs.kind.addEventListener('change', () => renderRules());

function options(select, anyLabel, items) {
  const value = select.value;
  fill(select, ruleInputs.kind.value === 'mute' ? el('option', { value: '', textContent: anyLabel }) : null,
    ...items.map(({ id, name }) => el('option', { value: id, textContent: name })));
  if ([...select.options].some((o) => o.value === value)) select.value = value;
}

function renderRules() {
  options(ruleInputs.channel, 'Any channel', state.data.channels.filter((c) => c.subscribed));
  options(ruleInputs.topic, 'Every group', state.data.topics);
  fill(els.rules, ...state.rules.map((r) => el('li', { className: 'topic-row' },
    el('span', { className: 'topic-name', textContent: ruleText(r) }),
    el('span', { className: 'actions' }, button('Delete', () => mutate(() => api('DELETE', `/api/rules/${r.id}`)), { key: `delete-rule-${r.id}`, ariaLabel: `Delete the rule: ${ruleText(r)}` })))));
}

els.ruleForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const { kind, pattern, channel, topic } = ruleInputs;
  sendInput(pattern, '/api/rules', (text) => ({ kind: kind.value, pattern: text, channel: channel.value || null, topic: topic.value || null }));
});

function channelRow(c, group) {
  const { ui } = state;
  const key = (what) => `${what}-${c.id}-${group}`;
  const star = starButton({
    pressed: c.favorite, dataset: { key: key('star') }, onToggle: () => patchChannel(c, { favorite: !c.favorite }),
    title: c.favorite ? 'Remove from favorite channels' : 'Add to favorite channels', ariaLabel: `Favorite: ${c.name}`,
  });
  // Under a topic heading, tag only the channel's other topics.
  const tags = el('span', { className: 'tags' },
    ...c.topics.filter((id) => id !== group).map((id) => el('span', { className: 'tag', textContent: topicName(id) })));
  const status = [];
  if (c.ok === false) status.push(el('span', { className: 'error', textContent: `Feed failed: ${c.error}` }));
  const backfill = backfillText(c);
  if (backfill && c.backfill !== 'done') status.push(el('span', { className: c.backfill === 'error' ? 'error' : 'muted', textContent: backfill }));

  const tick = el('input', { type: 'checkbox', className: 'tick', checked: state.selected.has(c.id), ariaLabel: `Select ${c.name}`, dataset: { key: key('select') } });
  tick.addEventListener('change', () => {
    if (tick.checked) state.selected.add(c.id);
    else state.selected.delete(c.id);
    state.bulkResult = '';
    render();
  });

  const head = channelHead(c, tick, star, c.handle ? el('span', { className: 'muted handle', textContent: c.handle }) : null, tags);
  const info = el('div', { className: 'row-info muted' }, el('span', { textContent: countsText(c) }), el('span', { textContent: lastUploadText(c) }), ...status);

  const editingTopics = ui.kind === 'topics' && ui.channelId === c.id && ui.group === group;
  const confirming = ui.kind === 'delete' && ui.channelId === c.id && ui.group === group;
  let actions;
  if (confirming) {
    const n = visibleCount(c.counts, false);
    actions = el('div', { className: 'row-actions confirm' },
      el('span', { textContent: `Delete ${c.name} and its ${plural(n, 'stored video')}? Favorites and watched marks on them go too.` }),
      button('Delete channel', () => mutate(() => api('DELETE', `/api/channels/${c.id}`), () => {
        state.ui = CLOSED;
        if (state.added?.id === c.id) state.added = null;
      }), { className: 'btn danger', key: key('delete-confirm') }),
      button('Cancel', () => setUi(CLOSED), { key: key('delete-cancel') }));
  } else {
    actions = el('div', { className: 'row-actions' },
      button(editingTopics ? 'Done' : 'Topics', () => setUi(editingTopics ? CLOSED : { kind: 'topics', channelId: c.id, group }), {
        key: key('topics'), ariaPressed: String(editingTopics), ariaLabel: `${editingTopics ? 'Done' : 'Topics'}: ${c.name}`,
      }),
      c.subscribed && !backfilling(c) && state.data.backfillAvailable
        ? button('Backfill', () => mutate(() => api('POST', `/api/channels/${c.id}/backfill`)), { key: key('backfill'), title: 'Load the full upload history from the YouTube API', ariaLabel: `Backfill ${c.name}` })
        : null,
      c.subscribed
        ? button('Unsubscribe', () => {
          // The row moves to Unsubscribed, so focus moves on to the next row's button, or else to its own Resubscribe.
          const next = (row.nextElementSibling ?? row.previousElementSibling)?.querySelector('[data-key^="subscribe-"]');
          const focusKey = next?.dataset.key ?? `subscribe-${c.id}-unsubscribed`;
          if (unsubscribe([c], `Unsubscribed from ${c.name}.`)) document.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
        }, { key: key('subscribe'), ariaLabel: `Unsubscribe from ${c.name}` })
        : button('Resubscribe', () => patchChannel(c, { subscribed: true }), { key: key('subscribe'), className: 'btn primary', ariaLabel: `Resubscribe to ${c.name}` }),
      button('Delete', () => setUi({ kind: 'delete', channelId: c.id, group }), { key: key('delete'), className: 'btn subtle-danger', ariaLabel: `Delete ${c.name}` }));
  }

  const row = el('li', { className: 'channel-row' }, head, info, actions);
  if (editingTopics) {
    row.append(el('div', { className: 'topic-editor' },
      ...state.data.topics.map((t) => {
        const box = el('input', { type: 'checkbox', checked: c.topics.includes(t.id), dataset: { key: key(`topic-${t.id}`) } });
        box.addEventListener('change', () => patchChannel(c, { topics: box.checked ? [...c.topics, t.id] : c.topics.filter((id) => id !== t.id) }));
        return el('label', { className: 'check' }, box, ` ${t.name}`);
      })));
  }
  return row;
}

function groupSection(title, channels, group, extraClass = '') {
  return el('section', { className: `group ${extraClass}` },
    el('h3', {}, title, el('span', { className: 'muted', textContent: ` ${channels.length}` })),
    el('ul', { className: 'rows' }, ...channels.map((c) => channelRow(c, group))));
}

function renderTools() {
  const period = el('select', { ariaLabel: 'Inactive period', hidden: state.view !== 'inactive', dataset: { key: 'inactive-period' } },
    ...INACTIVE_PERIODS.map(({ days, label }) => el('option', { value: String(days), textContent: `No upload in ${label}` })));
  period.value = String(state.inactiveDays);
  period.addEventListener('change', () => {
    state.inactiveDays = Number(period.value);
    prefs.set('manage.inactiveDays', state.inactiveDays);
    render();
  });
  const viewButton = (view, label) => button(label, () => {
    state.view = view;
    render();
  }, { className: 'pill', ariaPressed: String(state.view === view), key: `view-${view}` });
  fill(els.tools, viewButton('all', 'All'), viewButton('inactive', 'Inactive'), period);
  renderBulk();
}

const listOptions = () => ({ view: state.view, filter: state.filter, days: state.inactiveDays });
const shown = () => shownChannels(state.data.channels, listOptions());
// Unsubscribe takes only the ticked subscribed channels the list shows, so a tick hidden by the filter, view or period
// unsubscribes nothing. The topic buttons take every ticked channel.
const toUnsubscribe = () => tickedChannels(state.data.channels, state.selected, listOptions());

function renderBulk() {
  for (const id of state.selected) if (!channelById(id)) state.selected.delete(id);
  if (!state.data.topics.some((t) => t.id === state.bulkTopic)) state.bulkTopic = state.data.topics[0]?.id ?? '';
  const targets = toUnsubscribe();
  const list = shown();
  const n = state.selected.size;
  const parts = [
    button(`Select shown (${whole.format(list.length)})`, () => {
      for (const c of list) state.selected.add(c.id);
      state.bulkResult = '';
      render();
    }, { key: 'bulk-select-shown', title: 'Tick every channel the list shows', disabled: list.every((c) => state.selected.has(c.id)) }),
  ];
  if (n) {
    parts.push(el('span', { className: 'muted', textContent: `${plural(n, 'channel')} selected` }));
    parts.push(button('Clear', () => {
      state.selected.clear();
      state.bulkResult = '';
      render();
    }, { key: 'bulk-clear' }));
    if (state.data.topics.length) {
      const pick = el('select', { ariaLabel: 'Topic for the selected channels', dataset: { key: 'bulk-topic' } },
        ...state.data.topics.map((t) => el('option', { value: t.id, textContent: t.name, selected: t.id === state.bulkTopic })));
      pick.addEventListener('change', () => (state.bulkTopic = pick.value));
      const apply = (linked) => mutate(async () => {
        const topic = topicName(state.bulkTopic);
        const { changed } = await api('POST', `/api/topics/${state.bulkTopic}/channels`, { channels: [...state.selected], linked });
        const done = `${linked ? 'Added' : 'Removed'} ${topic} ${linked ? 'to' : 'from'} ${plural(changed, 'channel')}`;
        const same = n - changed;
        state.bulkResult = same ? `${done}; ${plural(same, 'other')} ${linked ? 'already had it' : 'did not have it'}.` : `${done}.`;
      });
      parts.push(el('span', { className: 'bulk-topic' }, pick,
        button('Add topic', () => apply(true), { key: 'bulk-add', className: 'btn primary' }),
        button('Remove topic', () => apply(false), { key: 'bulk-remove' })));
    }
    if (targets.length) parts.push(button(`Unsubscribe ${plural(targets.length, 'channel')}`, () => unsubscribe(targets, `Unsubscribed from ${plural(targets.length, 'channel')}.`), { key: 'unsubscribe-selected' }));
  }
  if (state.bulkResult) parts.push(el('span', { className: 'muted', textContent: state.bulkResult }));
  fill(els.bulk, ...parts);
}

function renderChannels() {
  if (state.view === 'inactive') return renderInactive();
  const channels = shown().toSorted((a, b) => a.name.localeCompare(b.name));
  const subscribed = channels.filter((c) => c.subscribed);
  const sections = state.data.topics
    .map((t) => [t, subscribed.filter((c) => c.topics.includes(t.id))])
    .filter(([, list]) => list.length)
    .map(([t, list]) => groupSection(t.name, list, t.id));
  const untagged = subscribed.filter((c) => !c.topics.length);
  if (untagged.length) sections.push(groupSection('No topic', untagged, NO_TOPIC));
  const unsubscribed = channels.filter((c) => !c.subscribed);
  if (unsubscribed.length) sections.push(groupSection('Unsubscribed', unsubscribed, 'unsubscribed', 'unsubscribed'));
  if (!sections.length) sections.push(el('p', { className: 'muted', textContent: state.filter ? 'No channel matches.' : 'No channels yet. Add one above.' }));
  fill(els.channels, ...sections);
}

function renderInactive() {
  const channels = shown();
  const label = INACTIVE_PERIODS.find((p) => p.days === state.inactiveDays)?.label ?? plural(state.inactiveDays, 'day');
  fill(els.channels, channels.length
    ? groupSection(`No upload in ${label}`, channels, 'inactive')
    : el('p', { className: 'muted', textContent: state.filter ? 'No inactive channel matches.' : `Every subscribed channel uploaded in the last ${label}.` }));
}

els.filter.addEventListener('input', () => {
  state.filter = els.filter.value.trim();
  renderBulk();
  renderChannels();
});

// The share page sends a shared channel here as ?add=, and with ?queue= the shared video that needs the channel.
const shared = new URLSearchParams(location.search);
if (shared.has('add')) {
  els.addInput.value = shared.get('add');
  state.pendingVideo = shared.get('queue');
  els.addInput.focus();
}

load().catch((err) => (els.notice.textContent = `Could not load channels: ${err.message}`));
registerServiceWorker();
