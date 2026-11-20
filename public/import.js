import { api, channelHead, el, fill, topicPicker } from './dom.js';
import { plural, whole } from './vocab.js';

const DAILY_QUOTA = 10_000;

// Where a review's channels come from. A YouTube review stores the unticked channels unsubscribed, as the check would
// offer them again otherwise.
const SOURCES = {
  csv: { reading: 'Reading the file and suggesting topics…', where: 'in the file', none: 'Every channel in the file is already in subfeed.', verb: 'Import', busyLabel: 'Importing…', doneVerb: 'Imported', ignoreUnticked: false },
  youtube: { reading: 'Looking the channels up and suggesting topics…', where: 'on YouTube', none: 'Every channel you subscribe to on YouTube is in subfeed.', verb: 'Add', busyLabel: 'Adding…', doneVerb: 'Added', ignoreUnticked: true },
};

// `topics()` returns the current topic list; `onChange()` reloads the rest of the page after topics or channels change.
// `open(fetchPreview)` starts a review of the preview it resolves to.
export function mountImport({ root, source, topics, onChange }) {
  const { reading, where, none, verb, busyLabel, doneVerb, ignoreUnticked } = SOURCES[source];
  // null | { phase: 'reading' } | { phase: 'error', message } | { phase: 'review' | 'importing', preview, picks } |
  // { phase: 'done', result }. `picks` maps channel id -> Set of topic ids, for the ticked channels only.
  let state = null;

  function set(next) {
    state = next;
    render();
  }

  async function open(fetchPreview) {
    set({ phase: 'reading' });
    try {
      const preview = await fetchPreview();
      set({ phase: 'review', preview, picks: new Map(preview.channels.map((c) => [c.id, new Set(c.topics)])) });
    } catch (err) {
      set({ phase: 'error', message: err.message });
    }
  }

  const toggleChannel = (id, on) => {
    const channel = state.preview.channels.find((c) => c.id === id);
    if (on) state.picks.set(id, new Set(channel.topics));
    else state.picks.delete(id);
    render();
  };

  const toggleTopic = (id, topicId) => {
    const picked = state.picks.get(id);
    if (picked.has(topicId)) picked.delete(topicId);
    else picked.add(topicId);
    render();
  };

  async function createGroup(group) {
    try {
      const topic = await api('POST', '/api/topics', { name: group.name });
      for (const c of state.preview.channels) if (group.channelIds.includes(c.id)) c.topics.push(topic.id);
      for (const id of group.channelIds) {
        const picked = state.picks.get(id) ?? new Set();
        state.picks.set(id, picked.add(topic.id));
      }
      state.preview.newGroups = state.preview.newGroups.filter((g) => g !== group);
      await onChange();
    } catch (err) {
      state.message = err.message;
    }
    render();
  }

  async function runImport() {
    const channels = state.preview.channels
      .filter((c) => ignoreUnticked || state.picks.has(c.id))
      .map(({ id, name, handle, avatar }) => (state.picks.has(id)
        ? { id, name, handle, avatar, topics: [...state.picks.get(id)] }
        : { id, name, handle, avatar, topics: [], subscribed: false }));
    set({ ...state, phase: 'importing' });
    try {
      set({ phase: 'done', result: await api('POST', '/api/import', { channels }) });
    } catch (err) {
      set({ ...state, phase: 'review', message: err.message });
    }
    await onChange();
  }

  function summary(preview) {
    const parts = [`${plural(preview.listed, 'channel')} ${where}`, `${whole.format(preview.alreadyIn)} already in subfeed`];
    if (preview.notFound) parts.push(`${whole.format(preview.notFound)} no longer on YouTube`);
    if (preview.lookupUnits) parts.push(`${plural(preview.lookupUnits, 'API unit')} for the lookup`);
    const by = preview.suggestedBy === 'claude' ? 'Topics suggested by Claude.' : 'Topics suggested by keyword match.';
    const fallback = preview.suggestError ? ` Claude failed (${preview.suggestError}), so keywords were used.` : '';
    return el('p', { className: 'muted', textContent: `${parts.join(' · ')}. ${by}${fallback}` });
  }

  function channelRow(c) {
    const ticked = state.picks.has(c.id);
    const box = el('input', { type: 'checkbox', checked: ticked, ariaLabel: `${verb} ${c.name}` });
    box.addEventListener('change', () => toggleChannel(c.id, box.checked));
    const picked = state.picks.get(c.id) ?? new Set();
    const info = [c.handle, c.videoCount === null ? null : plural(c.videoCount, 'video'), c.backfillUnits ? `backfill about ${plural(c.backfillUnits, 'unit')}` : null];
    return el('li', { className: 'channel-row' },
      channelHead(c, box, null, el('span', { className: 'muted handle', textContent: info.filter(Boolean).join(' · ') })),
      ticked ? el('div', { className: 'pick import-topics' }, ...topicPicker(topics(), picked, (topicId) => toggleTopic(c.id, topicId))) : null);
  }

  // With nothing ticked, a YouTube review still has something to do: send every channel to Unsubscribed.
  const actionLabel = (ticked, total) => (ticked || !ignoreUnticked ? `${verb} ${plural(ticked, 'channel')}` : `Move ${plural(total, 'channel')} to Unsubscribed`);

  function review() {
    const { preview, picks } = state;
    const busy = state.phase === 'importing';
    if (!preview.channels.length) return [summary(preview), el('p', { textContent: none })];
    const chosen = preview.channels.filter((c) => picks.has(c.id));
    const units = chosen.reduce((n, c) => n + c.backfillUnits, 0);
    const estimate = preview.backfillAvailable
      ? `Backfills run one channel at a time and use about ${plural(units, 'API unit')} in all. The daily quota is ${whole.format(DAILY_QUOTA)} units.`
      : 'No YouTube API key: imported channels get their RSS videos only.';
    const groups = preview.newGroups.map((g) =>
      el('p', { className: 'import-new-group' },
        `${plural(g.channelIds.length, 'channel')} fit no topic. Suggested new topic: `, el('strong', { textContent: g.name }), ' ',
        el('button', { type: 'button', className: 'btn', textContent: `Create ${g.name}`, onclick: () => createGroup(g) })));
    const all = (on) => {
      for (const c of preview.channels) if (on) picks.set(c.id, picks.get(c.id) ?? new Set(c.topics)); else picks.delete(c.id);
      render();
    };
    return [
      summary(preview),
      ...groups,
      el('div', { className: 'pick' },
        el('span', { className: 'muted', textContent: `${whole.format(chosen.length)} of ${plural(preview.channels.length, 'new channel')} ticked` }),
        el('button', { type: 'button', className: 'btn', textContent: 'Tick all', onclick: () => all(true) }),
        el('button', { type: 'button', className: 'btn', textContent: 'Untick all', onclick: () => all(false) })),
      el('ul', { className: 'rows import-list' }, ...preview.channels.map(channelRow)),
      el('p', { className: 'muted import-estimate', textContent: estimate }),
      ignoreUnticked ? el('p', { className: 'muted', textContent: 'Unticked channels go to Unsubscribed, so they are not offered again.' }) : null,
      state.message ? el('p', { className: 'error', textContent: state.message }) : null,
      el('div', { className: 'pick' },
        el('button', { type: 'button', className: 'btn primary', disabled: busy || !(chosen.length || ignoreUnticked), textContent: busy ? busyLabel : actionLabel(chosen.length, preview.channels.length), onclick: runImport }),
        el('button', { type: 'button', className: 'btn', disabled: busy, textContent: 'Cancel', onclick: () => set(null) })),
    ];
  }

  function done({ added, ignored, skipped, backfillsQueued }) {
    const lines = [`${doneVerb} ${plural(added, 'channel')} with their latest videos.`];
    if (ignored) lines.push(`${plural(ignored, 'channel')} went to Unsubscribed.`);
    if (skipped) lines.push(`${plural(skipped, 'channel')} were already in subfeed.`);
    if (backfillsQueued) lines.push(`${plural(backfillsQueued, 'backfill')} queued; they run one at a time, as the list below shows.`);
    return [el('div', { className: 'result' }, ...lines.map((textContent) => el('p', { textContent })))];
  }

  function render() {
    if (!state) return fill(root);
    switch (state.phase) {
      case 'reading':
        return fill(root, el('p', { className: 'muted', textContent: reading }));
      case 'error':
        return fill(root, el('p', { className: 'error', textContent: state.message }));
      case 'done':
        return fill(root, ...done(state.result));
      default:
        return fill(root, ...review());
    }
  }

  // Topics can change elsewhere on the page; drop picks of deleted ones.
  return {
    open,
    render: () => {
      if (state?.picks) {
        const known = new Set(topics().map((t) => t.id));
        for (const picked of state.picks.values()) for (const id of picked) if (!known.has(id)) picked.delete(id);
      }
      render();
    },
  };
}
