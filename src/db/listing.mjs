import { RATE_SQL } from '../hot.mjs';
import { wordsOf } from '../../public/vocab.js';
import { LISTED_COLUMNS, MARK_JOINS, VIDEO_FILTER, filterParams, toVideo } from './filters.mjs';

// Every word must start a word of the title or the description, in any order. Words are the runs of characters the
// unicode61 tokenizer keeps, quoted, so operators, quotes and stray punctuation never reach FTS5 syntax.
function matchQuery(text) {
  const words = wordsOf(text);
  return words.length ? words.map((w) => `"${w}"*`).join(' ') : null;
}

// A feed page over at least 1/MANY_CHANNELS of all channels walks the publish-time index instead of seeking per channel.
const MANY_CHANNELS = 4;

// bm25 of a search match, lower is better. A word in the title counts ten times one in the description, so a video
// about a thing ranks above one that mentions it in passing.
const SEARCH_RANK = 'bm25(videos_fts, 10, 1)';

// A search counts its matches up to this many. A common word matches most videos, and counting all of them took up to
// most of a second on a small home server.
export const MATCH_COUNT_CAP = 10_000;

// Search over `db`. openDb runs it on its own connection; openSearchDb gives it a read-only one.
export function searchPageOn(db) {
  // Starts from the matches, so a rare word reads a few rows. A common word costs time in proportion to its matches,
  // since bm25 has to read all of them.
  const matches = `
    FROM videos_fts s
    JOIN videos v ON v.rowid = s.rowid
    ${MARK_JOINS}
    WHERE videos_fts MATCH :match AND ${VIDEO_FILTER}`;
  // Best match first, newer first among equals. `rank` is recomputed for each page, so the cursor carries it.
  const page = db.prepare(`
    SELECT * FROM (SELECT ${LISTED_COLUMNS}, ${SEARCH_RANK} AS rank ${matches})
    WHERE :beforeRank IS NULL OR rank > :beforeRank OR (rank = :beforeRank AND (published, id) < (:beforePublished, :beforeId))
    ORDER BY rank, published DESC, id DESC
    LIMIT :limit OFFSET :offset`);
  const count = db.prepare(`SELECT count(*) AS n FROM (SELECT 1 ${matches} LIMIT ${MATCH_COUNT_CAP + 1})`);

  // Only videos whose title or description matches `q`, best match first; each video carries its `rank` for `before`,
  // and `offset` skips that many matches. A `q` with no words matches nothing.
  function listMatches({ q, limit, before, offset = 0, ...filters }) {
    const match = matchQuery(q);
    if (match === null) return { videos: [], more: false };
    const params = { ...filterParams(filters), beforeRank: before?.rank ?? null, beforePublished: before?.published ?? null, beforeId: before?.id ?? null, limit: limit + 1, offset, match };
    const rows = page.all(params).map((r) => ({ ...toVideo(r), rank: r.rank }));
    return { videos: rows.slice(0, limit), more: rows.length > limit };
  }

  // At most MATCH_COUNT_CAP + 1, which stands for "more than MATCH_COUNT_CAP".
  function countMatches({ q, ...filters }) {
    const match = matchQuery(q);
    return match ? count.get({ ...filterParams(filters), match }).n : 0;
  }

  // A page of matches; the first page also carries how many match in all, as `total`, and `totalCapped` when there are
  // more than MATCH_COUNT_CAP.
  function searchPage(query) {
    const result = listMatches(query);
    if (query.before) return result;
    const n = countMatches(query);
    return { ...result, total: Math.min(n, MATCH_COUNT_CAP), ...(n > MATCH_COUNT_CAP && { totalCapped: true }) };
  }

  return searchPage;
}

export function listing(db) {
  const keysetPage = `
    AND (:beforePublished IS NULL OR (v.published, v.id) < (:beforePublished, :beforeId))
    ORDER BY v.published DESC, v.id DESC
    LIMIT :limit`;
  const pageFrom = (from) => db.prepare(`
    SELECT ${LISTED_COLUMNS}
    FROM ${from}
    ${MARK_JOINS}
    WHERE ${VIDEO_FILTER} ${keysetPage}
  `);
  const pages = {
    // Seeks each channel's videos and sorts them, so it reads the selected channels' whole history.
    byChannel: pageFrom('videos v INDEXED BY videos_channel_recent'),
    // Walks all videos newest first and stops when the page is full, so it reads about a page per selected share of channels.
    byPublished: pageFrom('videos v INDEXED BY videos_published'),
    favorites: pageFrom('favorites fo CROSS JOIN videos v ON v.id = fo.video_id'),
    queue: pageFrom('queue qo CROSS JOIN videos v ON v.id = qo.video_id'),
  };
  const channelCount = db.prepare('SELECT count(*) AS n FROM channels');
  const pageFor = ({ channelIds, favoritesOnly, queuedOnly }) => {
    if (queuedOnly) return pages.queue;
    if (favoritesOnly) return pages.favorites;
    return channelIds.length * MANY_CHANNELS >= channelCount.get().n ? pages.byPublished : pages.byChannel;
  };
  const newer = `
    FROM videos v
    ${MARK_JOINS}
    WHERE ${VIDEO_FILTER} AND v.published > :since`;
  const newPage = db.prepare(`SELECT ${LISTED_COLUMNS} ${newer} ORDER BY v.published DESC, v.id DESC LIMIT :limit OFFSET :offset`);
  const newCount = db.prepare(`SELECT count(*) AS n ${newer}`);

  // An upcoming premiere has no views to rank yet.
  const inHotWindow = `v.published >= :since AND v.published <= :now AND v.views IS NOT NULL AND v.kind IS NOT 'upcoming'`;
  // The window is bounded, so an offset pages it; the caller passes the same :now for every page.
  const hotPage = db.prepare(`
    SELECT ${LISTED_COLUMNS}
    FROM videos v INDEXED BY videos_published
    ${MARK_JOINS}
    WHERE ${VIDEO_FILTER} AND ${inHotWindow}
    ORDER BY ${RATE_SQL} DESC, v.published DESC, v.id DESC
    LIMIT :limit OFFSET :offset
  `);
  const usualRates = db.prepare(`
    SELECT v.channel_id AS channelId, v.is_short AS isShort, count(*) AS n, sum(${RATE_SQL}) AS total
    FROM videos v
    WHERE v.channel_id IN (SELECT value FROM json_each(:channelIds)) AND ${inHotWindow}
    GROUP BY 1, 2
  `);

  // One index seek per channel finds its cutoff, so the window ranks about :perChannel rows per channel instead of
  // the whole history.
  const shelfRows = db.prepare(`
    WITH nth_newest AS (
      SELECT c.value AS channelId,
             (SELECT v.published FROM videos v LEFT JOIN favorites f ON f.video_id = v.id
              WHERE v.channel_id = c.value AND ${VIDEO_FILTER}
              ORDER BY v.published DESC, v.id DESC LIMIT 1 OFFSET :perChannel - 1) AS cutoff
      FROM json_each(:channelIds) c
      JOIN channels ch ON ch.id = c.value AND ch.subscribed = 1
    ),
    ranked AS (
      SELECT ${LISTED_COLUMNS},
             row_number() OVER (PARTITION BY v.channel_id ORDER BY v.published DESC, v.id DESC) AS rank
      FROM nth_newest n
      JOIN videos v ON v.channel_id = n.channelId AND v.published >= coalesce(n.cutoff, '')
      ${MARK_JOINS}
      WHERE ${VIDEO_FILTER}
    )
    SELECT *, max(published) OVER (PARTITION BY channelId) AS latest
    FROM ranked
    WHERE rank <= :perChannel
    ORDER BY latest DESC, channelId, rank
  `);

  const shelfOrder = db.prepare(`
    SELECT c.value AS channelId,
           (SELECT v.published FROM videos v LEFT JOIN favorites f ON f.video_id = v.id
            WHERE v.channel_id = c.value AND ${VIDEO_FILTER}
            ORDER BY v.published DESC, v.id DESC LIMIT 1) AS latest
    FROM json_each(:channelIds) c
    JOIN channels ch ON ch.id = c.value AND ch.subscribed = 1
  `);

  function listShelves({ perChannel, ...filters }) {
    const shelves = [];
    for (const r of shelfRows.all({ ...filterParams(filters), perChannel })) {
      if (r.rank === 1) shelves.push({ channelId: r.channelId, latest: r.latest, videos: [] });
      shelves.at(-1).videos.push(toVideo(r));
    }
    return shelves;
  }

  return {
    // `before` is the last row of the previous page.
    listVideos({ limit, before, ...filters }) {
      const params = { ...filterParams(filters), beforePublished: before?.published ?? null, beforeId: before?.id ?? null, limit: limit + 1 };
      const rows = pageFor(filters).all(params).map(toVideo);
      return { videos: rows.slice(0, limit), more: rows.length > limit };
    },

    searchPage: searchPageOn(db),

    listHot({ since, now, offset, limit, ...filters }) {
      const rows = hotPage.all({ ...filterParams(filters), since, now, offset, limit: limit + 1 }).map(toVideo);
      return { videos: rows.slice(0, limit), more: rows.length > limit };
    },

    // Keyed by `${channelId}:${isShort}`, since Shorts and long videos draw very different views per hour.
    usualRates({ channelIds, since, now }) {
      const rows = usualRates.all({ channelIds: JSON.stringify(channelIds), since, now });
      return new Map(rows.map((r) => [`${r.channelId}:${r.isShort === 1}`, { n: r.n, total: r.total }]));
    },

    newVideos({ since, limit, offset = 0, ...filters }) {
      const params = { ...filterParams(filters), since };
      return { videos: newPage.all({ ...params, limit, offset }).map(toVideo), total: newCount.get(params).n };
    },

    listShelves,

    listShelfPage({ perChannel, channels, after = null, ...filters }) {
      const order = shelfOrder
        .all(filterParams(filters))
        .filter((r) => r.latest !== null)
        .sort((x, y) => y.latest.localeCompare(x.latest) || x.channelId.localeCompare(y.channelId));
      const start = after === null ? 0 : order.findIndex((r) => r.latest < after.latest || (r.latest === after.latest && r.channelId > after.channelId));
      const page = start === -1 ? [] : order.slice(start, start + channels);
      const shelves = page.length ? listShelves({ ...filters, channelIds: page.map((r) => r.channelId), perChannel }) : [];
      const last = page.at(-1);
      return { shelves, next: last && start + channels < order.length ? { latest: last.latest, channelId: last.channelId } : null };
    },
  };
}
