import { describe, expect, it } from 'vitest';
import { convertSpelling } from './spelling';

const PAIRS: [string, string][] = [
  ['colour', 'color'],
  ['neighbourhood', 'neighborhood'],
  ['favourite', 'favorite'],
  ['realise', 'realize'],
  ['organisation', 'organization'],
  ['centre', 'center'],
  ['grey', 'gray'],
  ['travelled', 'traveled'],
  ['defence', 'defense'],
];

describe('convertSpelling: original', () => {
  it('returns the text unchanged', () => {
    const text = 'The colour of the centre was grey.';
    expect(convertSpelling(text, 'original')).toBe(text);
  });

  it('returns an empty string unchanged', () => {
    expect(convertSpelling('', 'original')).toBe('');
  });
});

describe('convertSpelling: british to american', () => {
  it.each(PAIRS)('converts %s to %s', (british, american) => {
    expect(convertSpelling(british, 'american')).toBe(american);
  });

  it('converts words inside a sentence', () => {
    expect(convertSpelling('My favourite colour is grey.', 'american')).toBe('My favorite color is gray.');
  });
});

describe('convertSpelling: american to british', () => {
  it.each(PAIRS)('converts %s back from %s', (british, american) => {
    expect(convertSpelling(american, 'british')).toBe(british);
  });

  it('converts words inside a sentence', () => {
    expect(convertSpelling('My favorite color is gray.', 'british')).toBe('My favourite colour is grey.');
  });
});

describe('convertSpelling: capitalisation', () => {
  it('keeps a leading capital', () => {
    expect(convertSpelling('Colour', 'american')).toBe('Color');
  });

  it('keeps all capitals', () => {
    expect(convertSpelling('COLOUR', 'american')).toBe('COLOR');
  });

  it('keeps a leading capital towards British', () => {
    expect(convertSpelling('Color', 'british')).toBe('Colour');
  });

  it('keeps all capitals towards British', () => {
    expect(convertSpelling('COLOR', 'british')).toBe('COLOUR');
  });
});

describe('convertSpelling: hyphens and punctuation', () => {
  it('converts the pieces of a hyphenated word', () => {
    expect(convertSpelling('good-humoured', 'american')).toBe('good-humored');
  });

  it('converts both pieces of a word hyphenated on both sides', () => {
    expect(convertSpelling('grey-coloured', 'american')).toBe('gray-colored');
  });

  it('keeps curly quotes and a comma around a word', () => {
    expect(convertSpelling('“Honour,” he said', 'american')).toBe('“Honor,” he said');
  });

  it('keeps surrounding punctuation and spacing', () => {
    expect(convertSpelling('(centre); "grey"\n  colour!', 'american')).toBe('(center); "gray"\n  color!');
  });
});

describe('convertSpelling: words not on the list', () => {
  const lookAlikes = ['hour', 'four', 'your', 'surprise', 'advise', 'exercise', 'tire', 'check'];

  it.each(lookAlikes)('leaves %s untouched towards American', (word) => {
    expect(convertSpelling(word, 'american')).toBe(word);
  });

  it.each(lookAlikes)('leaves %s untouched towards British', (word) => {
    expect(convertSpelling(word, 'british')).toBe(word);
  });

  it('leaves an unknown word and an empty string alone', () => {
    expect(convertSpelling('zebra quux', 'american')).toBe('zebra quux');
    expect(convertSpelling('', 'british')).toBe('');
  });
});

describe('convertSpelling: one-way words', () => {
  it('turns tyre into tire towards American', () => {
    expect(convertSpelling('tyre', 'american')).toBe('tire');
  });

  it('turns kerb into curb towards American', () => {
    expect(convertSpelling('kerb', 'american')).toBe('curb');
  });

  it('keeps tire as it is towards British', () => {
    expect(convertSpelling('I tire easily', 'british')).toBe('I tire easily');
  });

  it('keeps curb as it is towards British', () => {
    expect(convertSpelling('curb your enthusiasm', 'british')).toBe('curb your enthusiasm');
  });

  it('keeps check as it is towards British', () => {
    expect(convertSpelling('check', 'british')).toBe('check');
  });
});

describe('convertSpelling: structure', () => {
  const sentence = 'The grey tyre hit the kerb near the centre, and “Honour,” said the good-humoured traveller.';
  const words = (text: string) => text.split(/\s+/).filter((w) => w.length > 0);

  it('keeps the number of whitespace-separated words towards American', () => {
    expect(words(convertSpelling(sentence, 'american'))).toHaveLength(words(sentence).length);
  });

  it('keeps the number of whitespace-separated words towards British', () => {
    const american = convertSpelling(sentence, 'american');
    expect(words(convertSpelling(american, 'british'))).toHaveLength(words(sentence).length);
  });

  it('returns the original after British to American to British for two-way words', () => {
    const text = 'The colourful neighbourhood organised a grey centre, and “Honour,” they travelled in defence.';
    const american = convertSpelling(text, 'american');
    expect(american).not.toBe(text);
    expect(convertSpelling(american, 'british')).toBe(text);
  });
});
