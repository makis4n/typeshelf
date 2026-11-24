/**
 * The page's one copy of each local store.
 *
 * Both are opened on first use. The user store matters most: the sync
 * listens for changes on the very object the typing view saves through, so
 * the two must share it.
 */

import { openBookStore, type BookStore } from './books';
import { UserStore } from './userStore';

let books: BookStore | undefined;

/** Books kept on this device. */
export function bookStore(): BookStore {
  return (books ??= openBookStore());
}

let user: Promise<UserStore> | undefined;

/**
 * Places, sessions and the queue for the account. Rejects when the browser
 * refuses storage (some private windows); the next call tries again.
 */
export function userStore(): Promise<UserStore> {
  if (!user) {
    const opening = UserStore.open();
    user = opening;
    opening.catch(() => {
      if (user === opening) user = undefined;
    });
  }
  return user;
}
