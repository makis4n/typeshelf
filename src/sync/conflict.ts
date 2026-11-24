/**
 * The rules for when this device and the account disagree about a reader's
 * place in a book. Plain functions, no storage and no network.
 *
 * 1. If another device is further on in the book, never jump there silently:
 *    the reader is asked "continue from there?" when the book is opened.
 * 2. Otherwise the most recent save wins.
 */

import type { Position } from '../book/types';
import { saveTag, type ProgressRecord } from '../store/types';

/** Negative when `a` comes before `b` in the book, positive when after, 0 when they are the same place. */
export function comparePositions(a: Position, b: Position): number {
  return a.chapter - b.chapter || a.paragraph - b.paragraph || a.char - b.char;
}

export type Resolution =
  /** This device's place stands. */
  | 'keep-local'
  /** Move to the account's place without asking. */
  | 'take-remote'
  /** Another device is further on: keep this device's place and ask the reader. */
  | 'ask';

/**
 * Decide what to do with the account's copy of a reader's place.
 *
 * @param local    this device's place, if it has one
 * @param remote   the account's place
 * @param deviceId this device's id
 */
export function resolveProgress(local: ProgressRecord | undefined, remote: ProgressRecord, deviceId: string): Resolution {
  // Nothing here to jump away from.
  if (!local) return 'take-remote';
  // The account is only echoing this device's own save.
  if (remote.deviceId === deviceId) return 'keep-local';

  const order = comparePositions(remote.position, local.position);
  if (order === 0) return 'keep-local';
  if (order > 0) {
    // Asked already, and the answer was no.
    return local.declined === saveTag(remote) ? 'keep-local' : 'ask';
  }
  // The other device is further back: the most recent save wins.
  return remote.updatedAt > local.updatedAt ? 'take-remote' : 'keep-local';
}
