/**
 * Reads the metadata block Project Gutenberg puts above the start marker
 * ("Title: …", "Author: …", "Language: …").
 */

export interface HeaderMetadata {
  /** Undefined when the header has no title line. */
  title: string | undefined;
  author: string | undefined;
  /** BCP 47 tag, `und` when missing or not recognised. */
  language: string;
}

const LANGUAGE_TAGS: Record<string, string> = {
  english: 'en',
  french: 'fr',
  german: 'de',
  spanish: 'es',
  italian: 'it',
  portuguese: 'pt',
  dutch: 'nl',
  swedish: 'sv',
  finnish: 'fi',
  latin: 'la',
  danish: 'da',
  norwegian: 'no',
  polish: 'pl',
  russian: 'ru',
  greek: 'el',
  hungarian: 'hu',
  czech: 'cs',
  esperanto: 'eo',
};

/** Maps a language name ("English") or a short code ("en") to a BCP 47 tag. */
export function languageTag(value: string): string {
  const first = value.split(/[,;]/u)[0].trim().toLowerCase();
  const named = LANGUAGE_TAGS[first];
  if (named !== undefined) return named;
  return /^[a-z]{2,3}$/u.test(first) ? first : 'und';
}

/**
 * Collects `Key: value` lines. A title (or any value) may wrap onto following
 * lines that are indented; a blank line ends the wrap.
 *
 * @param lines Every line above the start marker.
 */
export function parseHeader(lines: readonly string[]): HeaderMetadata {
  const fields = new Map<string, string>();
  let current: string | undefined;

  for (const line of lines) {
    if (line.trim() === '') {
      current = undefined;
      continue;
    }
    const field = /^([A-Za-z][A-Za-z ]*?):[ \t]*(.*)$/u.exec(line);
    if (field !== null) {
      current = field[1].toLowerCase();
      if (!fields.has(current)) fields.set(current, field[2].trim());
      else current = undefined; // a repeated key is ignored, with its wrapped lines
      continue;
    }
    if (current !== undefined && /^\s/u.test(line)) {
      fields.set(current, `${fields.get(current)} ${line.trim()}`.trim());
    } else {
      current = undefined;
    }
  }

  const language = fields.get('language');
  return {
    title: fields.get('title') || undefined,
    author: fields.get('author') || undefined,
    language: language === undefined ? 'und' : languageTag(language),
  };
}
