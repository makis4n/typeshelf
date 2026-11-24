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
/** The store `user` resolved to, to see when its connection has gone. */
let opened: UserStore | undefined;

/**
 * Places, sessions and the queue for the account. Rejects when the browser
 * refuses storage (some private windows); the next call tries again. A
 * store whose connection has been closed is replaced by a fresh one on the
 * next call, so later saves are not made through a dead connection.
 */
export function userStore(): Promise<UserStore> {
  if (opened?.closed) {
    user = undefined;
    opened = undefined;
  }
  if (!user) {
    const opening = UserStore.open();
    user = opening;
    opening.then(
      (store) => {
        if (user === opening) opened = store;
      },
      () => {
        if (user === opening) user = undefined;
      },
    );
  }
  return user;
}
