/** The one shape every book source (Gutenberg, EPUB, text) converts into. */
export type BookSource = 'gutenberg' | 'epub' | 'text';

export interface Chapter {
  title: string;
  /** Plain text, one string per paragraph, as fed to `buildPassage`. */
  paragraphs: string[];
}

export interface Book {
  /** `gutenberg:<number>` or `import:<fingerprint>`. */
  id: string;
  title: string;
  author: string;
  /** BCP 47 tag, `und` when unknown. */
  language: string;
  source: BookSource;
  /** Lowercase hex SHA-256. For imports: of the original file's bytes. */
  fingerprint: string;
  chapters: Chapter[];
}

/** A place in a book. Not one big character count, so re-cleaning a book does not shift it. */
export interface Position {
  chapter: number;
  paragraph: number;
  /** Characters of the paragraph already typed. */
  char: number;
}
