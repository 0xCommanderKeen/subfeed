import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGroups, dropsChannel, groupHasNew, groupSize, groupsMarkedSeen, monograms, setMark, tallySets } from '../public/groups.js';

test('monograms read as the topic names', () => {
  const names = ['3D Printing', '3D Business', 'Miniature Painting', 'Miniature Gaming', 'Blood Bowl', 'Board Games', 'Minecraft'];
  assert.deepEqual(monograms(names), ['3D', '3B', 'MP', 'MG', 'BB', 'BG', 'MI']);
});

test('monograms stay unique when names share initials', () => {
  const names = ['Mini Golf', 'Miniature Gaming', 'Model Gliders', 'Minecraft', 'Mining', 'M', 'M', '!!!', '', 'Ma', 'Mb', 'Mc', 'Md', 'Me', 'Mf', 'Mg', 'Mh'];
  const marks = monograms(names);
  assert.equal(new Set(marks).size, names.length, marks.join(' '));
  assert.deepEqual(marks.slice(0, 3), ['MG', 'MI', 'MO']);
  assert.ok(marks.every((m) => typeof m === 'string' && m.length >= 2), marks.join(' '));
});

test('group sizes and new dots follow Hide Shorts and the stored visits', () => {
  const channel = (id, topics, favorite, counts, latest, starred, queued = { long: 1, short: 2, stream: 0 }) => ({ id, topics, favorite, counts, latest, starred, queued, inTopic: {} });
  const meta = {
    topics: [{ id: 'print', name: '3D Printing', hidden: false }, { id: 'paint', name: 'Miniature Painting', hidden: false }],
    channels: [
      channel('a', ['print'], true, { long: 10, short: 4, stream: 0 }, { long: '2025-01-01', short: '2025-03-01', stream: null }, { long: 2, short: 1, stream: 0 }),
      channel('b', ['paint'], false, { long: 5, short: 0, stream: 0 }, { long: '2025-02-01', short: null, stream: null }, { long: 0, short: 0, stream: 0 }),
    ],
    visits: { all: '2025-02-15', 'topic:print': '2025-02-15', 'topic:paint': '2025-01-15', 'favorite-channels': '2025-04-01' },
  };
  const groups = Object.fromEntries(buildGroups(meta).map((g) => [g.id, g]));
  const sizes = (hide) => Object.fromEntries(Object.values(groups).map((g) => [g.id, groupSize(g, meta, { hideShorts: hide })]));
  assert.deepEqual(sizes(true), { all: 15, 'topic:print': 10, 'topic:paint': 5, 'favorite-channels': 10, favorites: 2, 'watch-later': 2 });
  assert.deepEqual(sizes(false), { all: 19, 'topic:print': 14, 'topic:paint': 5, 'favorite-channels': 14, favorites: 3, 'watch-later': 6 });
  const fresh = (hide) => Object.values(groups).filter((g) => groupHasNew(g, meta, { hideShorts: hide })).map((g) => g.id);
  assert.deepEqual(fresh(true), ['topic:paint']);
  assert.deepEqual(fresh(false), ['all', 'topic:print', 'topic:paint']);
});

test('marking Everything seen covers every group with new dots, and any other group covers only itself', () => {
  const groups = buildGroups({ topics: [{ id: 'print', name: '3D Printing', hidden: false }, { id: 'paint', name: 'Miniature Painting', hidden: false }], channels: [], visits: {} });
  const ids = (group) => groupsMarkedSeen(group, groups).map((g) => g.id);
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
  assert.deepEqual(ids(byId.all), ['all', 'topic:print', 'topic:paint', 'favorite-channels']);
  assert.deepEqual(ids(byId['topic:print']), ['topic:print']);
});

test('a hidden topic keeps its group and mark, flagged for the More fold', () => {
  const groups = buildGroups({ topics: [{ id: 'print', name: '3D Printing', hidden: true }, { id: 'paint', name: 'Miniature Painting', hidden: false }], channels: [], visits: {} });
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
  assert.equal(byId['topic:print'].hidden, true);
  assert.equal(byId['topic:print'].monogram, '3D');
  assert.equal(byId['topic:paint'].hidden, false);
  assert.ok(groups.filter((g) => g.id !== 'topic:print').every((g) => !g.hidden));
  assert.deepEqual(groupsMarkedSeen(byId.all, groups).map((g) => g.id), ['all', 'topic:print', 'topic:paint', 'favorite-channels']);
});

test('a meta refresh that drops a channel the tab knew is told apart from one that only adds channels', () => {
  const known = new Map([['UCa', {}], ['UCb', {}]]);
  assert.equal(dropsChannel(known, new Map([['UCa', {}]])), true, 'an unsubscribed channel redraws the screen');
  assert.equal(dropsChannel(known, new Map([['UCa', {}], ['UCb', {}], ['UCc', {}]])), false, 'an added channel keeps the screen');
  assert.equal(dropsChannel(known, new Map(known)), false);
});

const zero = () => ({ long: 0, short: 0, stream: 0 });
const tallies = () => ({ counts: zero(), starred: zero(), queued: zero(), unwatched: { counts: zero(), starred: zero(), queued: zero() } });
const markChannel = () => ({ ...tallies(), raw: tallies(), inTopic: { print: tallies() } });
const marks = (c, list) => tallySets(c).flatMap(([t]) => [t[list].long, t.unwatched[list].long]);

for (const [mark, list] of [['favorite', 'starred'], ['queued', 'queued']]) {
  test(`a ${mark} toggled twice keeps the counts when the first request fails and the second succeeds`, () => {
    const c = markChannel();
    const v = { [mark]: false, watched: false, isShort: false };
    const next1 = !v[mark];
    setMark(v, c, mark, next1);
    const next2 = !v[mark];
    setMark(v, c, mark, next2);
    assert.equal(setMark(v, c, mark, !next1), false, 'undoing the failed first click changes nothing');
    assert.equal(v[mark], false);
    assert.deepEqual(marks(c, list), [0, 0, 0, 0, 0, 0]);
  });

}

test('a failed take off Watch Later restores the mark and the counts', () => {
  const c = markChannel();
  const v = { queued: false, watched: true, isShort: true };
  setMark(v, c, 'queued', true);
  const start = tallySets(c).map(([t]) => structuredClone(t));
  setMark(v, c, 'queued', false);
  assert.equal(c.queued.short, 0);
  setMark(v, c, 'queued', true);
  assert.equal(v.queued, true);
  assert.deepEqual(tallySets(c).map(([t]) => t), start);
  assert.equal(c.unwatched.queued.short, 0, 'a watched video stays out of the unwatched tallies');
});
