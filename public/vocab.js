// Ids, search words and formats that the server, the MCP tools and the page share. No DOM here.

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
// The longest search query, in characters.
export const MAX_QUERY = 200;

// The runs of characters the unicode61 tokenizer keeps as words.
export const WORD = /[\p{L}\p{N}\p{Co}]+/gu;
export const wordsOf = (text) => text.match(WORD) ?? [];
// Case and accents do not count, as in the search index.
export const fold = (text) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();

// A rule's pattern matches a title holding its words in a row, as whole words, ignoring case, accents and punctuation:
// "live" matches "LIVE: Q&A" but not "Delivery". Not a regex, so rules stay easy to write.
// The database stores these for titles and patterns, so matching there is a plain substring test.
// A change to fold, wordsOf or spacedWords needs a migration in src/schema.mjs that folds the stored words again.
export const spacedWords = (text) => ` ${wordsOf(fold(text ?? '')).join(' ')} `;
export const titleHas = (title, pattern) => spacedWords(pattern).trim() !== '' && spacedWords(title).includes(spacedWords(pattern));

const AGE_STEPS = [[60, 's', 1], [3600, 'm', 60], [86400, 'h', 3600], [604800, 'd', 86400], [2629800, 'w', 604800], [31557600, 'mo', 2629800]];

// "5m", "3h", "4mo": the time since `iso`, in its largest whole unit.
export function formatAge(iso, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  for (const [limit, unit, size] of AGE_STEPS) if (s < limit) return `${Math.floor(s / size)}${unit}`;
  return `${Math.floor(s / 31557600)}y`;
}

// "1:02:05" or "10:00".
export function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export const whole = new Intl.NumberFormat('en');
export const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export const plural = (n, word, many = `${word}s`) => `${whole.format(n)} ${n === 1 ? word : many}`;
