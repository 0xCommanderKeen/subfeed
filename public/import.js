import { api, channelHead, el, fill, topicPicker } from './dom.js';
import { plural, whole } from './vocab.js';

const DAILY_QUOTA = 10_000;

// `topics()` returns the current topic list; `onChange()` reloads the rest of the page after topics or channels change.
export function mountImport({ fileInput, fileName, root, topics, onChange }) {
  // null | { phase: 'reading' } | { phase: 'error', message } | { phase: 'review' | 'importing', preview, picks } |
  // { phase: 'done', result }. `picks` maps channel id -> Set of topic ids, for the ticked channels only.
  let state = null;

  function set(next) {
    state = next;
    render();
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    fileName.textContent = file.name;
    set({ phase: 'reading' });
    try {
      const preview = await api('POST', '/api/import/preview', { csv: await file.text() });
      set({ phase: 'review', preview, picks: new Map(preview.channels.map((c) => [c.id, new Set(c.topics)])) });
    } catch (err) {
      set({ phase: 'error', message: err.message });
    }
    fileInput.value = '';
  });

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
      .filter((c) => state.picks.has(c.id))
      .map(({ id, name, handle, avatar }) => ({ id, name, handle, avatar, topics: [...state.picks.get(id)] }));
    set({ ...state, phase: 'importing' });
    try {
      set({ phase: 'done', result: await api('POST', '/api/import', { channels }) });
    } catch (err) {
      set({ ...state, phase: 'review', message: err.message });
    }
    await onChange();
  }

  function summary(preview) {
    const parts = [`${plural(preview.listed, 'channel')} in the file`, `${whole.format(preview.alreadyIn)} already in subfeed`];
    if (preview.notFound) parts.push(`${whole.format(preview.notFound)} no longer on YouTube`);
    if (preview.lookupUnits) parts.push(`${plural(preview.lookupUnits, 'API unit')} for the lookup`);
    const by = preview.suggestedBy === 'claude' ? 'Topics suggested by Claude.' : 'Topics suggested by keyword match.';
    const fallback = preview.suggestError ? ` Claude failed (${preview.suggestError}), so keywords were used.` : '';
    return el('p', { className: 'muted', textContent: `${parts.join(' · ')}. ${by}${fallback}` });
  }

  function channelRow(c) {
    const ticked = state.picks.has(c.id);
    const box = el('input', { type: 'checkbox', checked: ticked, ariaLabel: `Import ${c.name}` });
    box.addEventListener('change', () => toggleChannel(c.id, box.checked));
    const picked = state.picks.get(c.id) ?? new Set();
    const info = [c.handle, c.videoCount === null ? null : plural(c.videoCount, 'video'), c.backfillUnits ? `backfill about ${plural(c.backfillUnits, 'unit')}` : null];
    return el('li', { className: 'channel-row' },
      channelHead(c, box, null, el('span', { className: 'muted handle', textContent: info.filter(Boolean).join(' · ') })),
      ticked ? el('div', { className: 'pick import-topics' }, ...topicPicker(topics(), picked, (topicId) => toggleTopic(c.id, topicId))) : null);
  }

  function review() {
    const { preview, picks } = state;
    const busy = state.phase === 'importing';
    if (!preview.channels.length) return [summary(preview), el('p', { textContent: 'Every channel in the file is already in subfeed.' })];
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
      state.message ? el('p', { className: 'error', textContent: state.message }) : null,
      el('div', { className: 'pick' },
        el('button', { type: 'button', className: 'btn primary', disabled: busy || !chosen.length, textContent: busy ? 'Importing…' : `Import ${plural(chosen.length, 'channel')}`, onclick: runImport }),
        el('button', { type: 'button', className: 'btn', disabled: busy, textContent: 'Cancel', onclick: () => set(null) })),
    ];
  }

  function done({ added, skipped, backfillsQueued }) {
    const lines = [`Imported ${plural(added, 'channel')} with their latest videos.`];
    if (skipped) lines.push(`${plural(skipped, 'channel')} were already in subfeed.`);
    if (backfillsQueued) lines.push(`${plural(backfillsQueued, 'backfill')} queued; they run one at a time, as the list below shows.`);
    return [el('div', { className: 'result' }, ...lines.map((textContent) => el('p', { textContent })))];
  }

  function render() {
    if (!state) return fill(root);
    switch (state.phase) {
      case 'reading':
        return fill(root, el('p', { className: 'muted', textContent: 'Reading the file and suggesting topics…' }));
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
    render: () => {
      if (state?.picks) {
        const known = new Set(topics().map((t) => t.id));
        for (const picked of state.picks.values()) for (const id of picked) if (!known.has(id)) picked.delete(id);
      }
      render();
    },
  };
}
