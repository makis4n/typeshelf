/**
 * The background side of importing: parses one file off the page's thread, so
 * that nothing a file contains can freeze the page. `background.ts` is the
 * page's side.
 */

import { ImportError } from './errors';
import { parseBook, type PickedFile } from './index';
import type { ParseReply } from './background';

addEventListener('message', (event: MessageEvent<PickedFile>) => {
  const reply = (message: ParseReply) => postMessage(message);
  parseBook(event.data).then(
    (book) => reply({ ok: true, book }),
    (error: unknown) =>
      reply({ ok: false, code: error instanceof ImportError ? error.code : undefined, detail: String(error) }),
  );
});
