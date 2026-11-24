/**
 * Converts text between British and American spelling, one word at a time.
 *
 * It works from a fixed word list, not from rules, because rules misfire
 * ("our" to "or" would turn "hour" into "hor"). Words not on the list are
 * left exactly as printed, so the list is a floor, not a guarantee.
 *
 * Every swap is one word for one word, so word counts never change.
 */

export type Spelling = 'original' | 'british' | 'american';

/** British stems ending in "our" whose American form ends in "or". */
const OUR_STEMS = [
  'arm', 'behavi', 'cand', 'clam', 'col', 'demean', 'endeav', 'fav', 'ferv', 'flav', 'harb', 'hon',
  'hum', 'lab', 'neighb', 'od', 'parl', 'ranc', 'rum', 'sav', 'splend', 'succ', 'tum', 'val', 'vap', 'vig',
];
const OUR_ENDINGS = [
  '', 's', 'ed', 'ing', 'able', 'ably', 'ful', 'fully', 'less', 'er', 'ers', 'ite', 'ites', 'hood',
  'hoods', 'ly', 'y', 'ing', 'ings',
];

/** British verbs in "-ise" (stem given without the final "e") whose American form is "-ize". */
const ISE_STEMS = [
  'agonis', 'apologis', 'authoris', 'baptis', 'capitalis', 'characteris', 'civilis', 'criticis',
  'economis', 'emphasis', 'familiaris', 'fertilis', 'generalis', 'harmonis', 'idolis', 'jeopardis',
  'materialis', 'memoris', 'mobilis', 'monopolis', 'moralis', 'neutralis', 'normalis', 'organis',
  'patronis', 'penalis', 'popularis', 'prioritis', 'rationalis', 'realis', 'recognis', 'revolutionis',
  'satiris', 'scrutinis', 'specialis', 'stabilis', 'standardis', 'sterilis', 'subsidis', 'summaris',
  'symbolis', 'sympathis', 'terroris', 'theoris', 'tyrannis', 'utilis', 'vandalis', 'victimis', 'visualis',
];
const ISE_ENDINGS = ['e', 'es', 'ed', 'ing', 'ation', 'ations', 'er', 'ers'];

/** Pairs that convert in both directions: [British, American]. */
const PAIRS: [string, string][] = [
  ['analyse', 'analyze'], ['analysed', 'analyzed'], ['analysing', 'analyzing'],
  ['paralyse', 'paralyze'], ['paralysed', 'paralyzed'], ['paralysing', 'paralyzing'],
  ['centre', 'center'], ['centres', 'centers'], ['centred', 'centered'], ['centring', 'centering'],
  ['theatre', 'theater'], ['theatres', 'theaters'],
  ['fibre', 'fiber'], ['fibres', 'fibers'], ['litre', 'liter'], ['litres', 'liters'],
  ['lustre', 'luster'], ['sombre', 'somber'], ['spectre', 'specter'], ['spectres', 'specters'],
  ['sceptre', 'scepter'], ['calibre', 'caliber'], ['sabre', 'saber'], ['sabres', 'sabers'],
  ['meagre', 'meager'], ['manoeuvre', 'maneuver'], ['manoeuvres', 'maneuvers'],
  ['manoeuvred', 'maneuvered'], ['manoeuvring', 'maneuvering'],
  ['grey', 'gray'], ['greys', 'grays'], ['greyer', 'grayer'], ['greyish', 'grayish'],
  ['defence', 'defense'], ['defences', 'defenses'], ['offence', 'offense'], ['offences', 'offenses'],
  ['pretence', 'pretense'], ['pretences', 'pretenses'],
  ['travelled', 'traveled'], ['travelling', 'traveling'], ['traveller', 'traveler'], ['travellers', 'travelers'],
  ['cancelled', 'canceled'], ['cancelling', 'canceling'],
  ['quarrelled', 'quarreled'], ['quarrelling', 'quarreling'],
  ['levelled', 'leveled'], ['levelling', 'leveling'], ['labelled', 'labeled'], ['labelling', 'labeling'],
  ['modelled', 'modeled'], ['modelling', 'modeling'], ['signalled', 'signaled'], ['signalling', 'signaling'],
  ['marvelled', 'marveled'], ['marvelling', 'marveling'], ['marvellous', 'marvelous'],
  ['counsellor', 'counselor'], ['counsellors', 'counselors'], ['jewellery', 'jewelry'],
  ['jeweller', 'jeweler'], ['jewellers', 'jewelers'], ['woollen', 'woolen'],
  ['plough', 'plow'], ['ploughs', 'plows'], ['ploughed', 'plowed'], ['ploughing', 'plowing'],
  ['mould', 'mold'], ['moulds', 'molds'], ['moulded', 'molded'], ['mouldy', 'moldy'],
  ['smoulder', 'smolder'], ['smouldered', 'smoldered'], ['smouldering', 'smoldering'],
  ['catalogue', 'catalog'], ['catalogues', 'catalogs'],
  ['aluminium', 'aluminum'], ['pyjamas', 'pajamas'], ['sceptic', 'skeptic'], ['sceptics', 'skeptics'],
  ['sceptical', 'skeptical'], ['scepticism', 'skepticism'], ['cosy', 'cozy'],
  ['judgement', 'judgment'], ['judgements', 'judgments'],
  ['acknowledgement', 'acknowledgment'], ['acknowledgements', 'acknowledgments'],
  ['ageing', 'aging'], ['enrol', 'enroll'], ['enrolment', 'enrollment'],
  ['fulfil', 'fulfill'], ['fulfilment', 'fulfillment'], ['skilful', 'skillful'], ['wilful', 'willful'],
  ['instalment', 'installment'], ['instalments', 'installments'], ['distil', 'distill'],
  ['appal', 'appall'], ['enthral', 'enthrall'],
  ['encyclopaedia', 'encyclopedia'], ['anaemia', 'anemia'], ['anaemic', 'anemic'],
  ['anaesthetic', 'anesthetic'], ['foetus', 'fetus'], ['diarrhoea', 'diarrhea'],
  ['leukaemia', 'leukemia'], ['haemorrhage', 'hemorrhage'], ['paediatric', 'pediatric'],
  ['sulphur', 'sulfur'], ['moustache', 'mustache'], ['moustaches', 'mustaches'],
  ['omelette', 'omelet'], ['omelettes', 'omelets'], ['tranquillise', 'tranquilize'],
];

/**
 * British words that only convert towards American. The American word also
 * has another meaning, so turning it back into the British one would be wrong
 * ("the car's tire" is "tyre", but "I tire easily" is not).
 */
const BRITISH_ONLY: [string, string][] = [
  ['tyre', 'tire'], ['tyres', 'tires'], ['kerb', 'curb'], ['kerbs', 'curbs'],
  ['gaol', 'jail'], ['gaols', 'jails'], ['gaoler', 'jailer'],
  ['cheque', 'check'], ['cheques', 'checks'], ['draught', 'draft'], ['draughts', 'drafts'],
];

function buildTables(): { toAmerican: Map<string, string>; toBritish: Map<string, string> } {
  const toAmerican = new Map<string, string>();
  const toBritish = new Map<string, string>();
  const both = (british: string, american: string) => {
    toAmerican.set(british, american);
    toBritish.set(american, british);
  };

  for (const stem of OUR_STEMS) for (const ending of OUR_ENDINGS) both(`${stem}our${ending}`, `${stem}or${ending}`);
  for (const stem of ISE_STEMS) {
    for (const ending of ISE_ENDINGS) both(`${stem}${ending}`, `${stem.slice(0, -1)}z${ending}`);
  }
  for (const [british, american] of PAIRS) both(british, american);
  for (const [british, american] of BRITISH_ONLY) toAmerican.set(british, american);

  return { toAmerican, toBritish };
}

const TABLES = buildTables();

/** Give `word` the capitalisation of `like`: lower, Capitalised or UPPER. */
function matchCase(word: string, like: string): string {
  if (like.length > 1 && like === like.toUpperCase()) return word.toUpperCase();
  if (like[0] === like[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

/** Convert one piece of text. `original` returns it untouched. */
export function convertSpelling(text: string, spelling: Spelling): string {
  if (spelling === 'original') return text;
  const table = spelling === 'american' ? TABLES.toAmerican : TABLES.toBritish;
  // Runs of letters are words; everything between them (spaces, hyphens,
  // quotes, punctuation) is kept as it is. So "good-humoured" converts too.
  return text.replace(/\p{L}+/gu, (word) => {
    const swap = table.get(word.toLowerCase());
    return swap === undefined ? word : matchCase(swap, word);
  });
}
