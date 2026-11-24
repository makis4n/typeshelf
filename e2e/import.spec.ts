import { expect, test, type Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';

const xhtml = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>x</title></head><body>${body}</body></html>`;

/** A small EPUB 3, built here so no book file is kept in the repo. */
function makeEpub(options: { encrypted?: boolean } = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    ),
    'OEBPS/book.opf': strToU8(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:identifier id="id">typeshelf-test</dc:identifier>
          <dc:title>The Lighthouse Keeper</dc:title><dc:creator>Ada Quill</dc:creator><dc:language>en</dc:language>
        </metadata>
        <manifest>
          <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
          <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
          <item id="one" href="one.xhtml" media-type="application/xhtml+xml"/>
          <item id="two" href="two.xhtml" media-type="application/xhtml+xml"/>
        </manifest>
        <spine><itemref idref="cover"/><itemref idref="one"/><itemref idref="two"/></spine>
      </package>`,
    ),
    'OEBPS/nav.xhtml': strToU8(
      xhtml(
        `<nav epub:type="toc"><ol><li><a href="one.xhtml">The Lamp</a></li><li><a href="two.xhtml">The Storm</a></li></ol></nav>`,
      ),
    ),
    'OEBPS/cover.xhtml': strToU8(xhtml(`<img src="cover.jpg" alt="Cover"/>`)),
    'OEBPS/one.xhtml': strToU8(
      xhtml(
        `<h1>The Lamp</h1><p>Every evening she <em>climbed</em> the stairs<a epub:type="noteref" href="#n1">1</a> to light the lamp.</p><p>Nobody asked her to.</p>`,
      ),
    ),
    'OEBPS/two.xhtml': strToU8(xhtml(`<h1>The Storm</h1><p>The wind came first.</p>`)),
  };
  if (options.encrypted) {
    files['META-INF/encryption.xml'] = strToU8(
      `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
        <enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/>
          <enc:CipherData><enc:CipherReference URI="OEBPS/one.xhtml"/></enc:CipherData></enc:EncryptedData>
      </encryption>`,
    );
  }
  return zipSync(files);
}

const importDialog = (page: Page) => page.locator('dialog.import');

/** Puts a file in the modal's file picker, as choosing it in the system dialog would. */
async function pick(page: Page, name: string, bytes: Uint8Array, type: string): Promise<void> {
  await importDialog(page)
    .locator('input[type=file]')
    .evaluate(
      (input: HTMLInputElement, file) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
      { name, type, bytes: Array.from(bytes) },
    );
}

async function openImport(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(importDialog(page)).toHaveAttribute('open', '');
}

test('imports an EPUB and a text file, and types the first chapter of each', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.ts-para').first()).toBeVisible();

  // An EPUB, through the file picker.
  await openImport(page);
  await pick(page, 'lighthouse.epub', makeEpub(), 'application/epub+zip');

  await expect(page.locator('.book h1')).toHaveText('The Lighthouse Keeper');
  await expect(page.locator('.book p')).toHaveText('Ada Quill · The Lamp');
  await expect(importDialog(page)).not.toHaveAttribute('open', '');
  await expect(page.locator('.ts')).toHaveClass(/ts-focused/);
  // The cover page, the heading and the footnote marker are not part of the text.
  await expect(page.locator('.ts-para').first()).toHaveText(/^Every\s*evening\s*she\s*climbed\s*the\s*stairs\s*to/);

  await page.keyboard.type('Every evening she climbed ');
  await expect(page.locator('.c.ok')).toHaveCount('Everyeveningsheclimbed'.length);
  await expect(page.locator('.c.bad, .c.extra, .c.miss, .w.flawed')).toHaveCount(0);
  await expect(page.locator('[data-stat="accuracy"]')).toHaveText('100%');

  // A text file, dropped on the page.
  const text = 'Chapter 1\n\nThe tide went out\nbefore dawn.\n\nNobody saw it go.\n\nChapter 2\n\nIt came back at noon.\n';
  const dropped = await page.evaluateHandle((content) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([content], 'the_tide.txt', { type: 'text/plain' }));
    return transfer;
  }, text);
  await page.dispatchEvent('body', 'drop', { dataTransfer: dropped });

  await expect(page.locator('.book h1')).toHaveText('the tide');
  await expect(page.locator('.book p')).toHaveText('Chapter 1');
  await expect(page.locator('.ts')).toHaveClass(/ts-focused/);
  // The broken line is joined back into one paragraph.
  await page.keyboard.type('The tide went out before dawn. ');
  await expect(page.locator('.ts-para').first().locator('.c.ok')).toHaveCount('Thetidewentoutbeforedawn.'.length);
  await expect(page.locator('.c.bad, .c.extra, .c.miss, .w.flawed')).toHaveCount(0);

  // Both books are kept on the device, and the same file again is not stored twice.
  await openImport(page);
  await expect(importDialog(page).locator('.shelf li')).toHaveCount(2);
  await pick(page, 'renamed.epub', makeEpub(), 'application/epub+zip');
  await expect(page.locator('.book h1')).toHaveText('The Lighthouse Keeper');
  await openImport(page);
  await expect(importDialog(page).locator('.shelf li')).toHaveCount(2);

  // A stored book survives a reload and can be opened from the list.
  await page.reload();
  await openImport(page);
  await importDialog(page).getByRole('button', { name: 'Type the tide' }).click();
  await expect(page.locator('.book h1')).toHaveText('the tide');
});

test('explains why a copy-protected or unsupported file cannot be imported', async ({ page }) => {
  await page.goto('/');
  await openImport(page);
  const alert = importDialog(page).getByRole('alert');

  await pick(page, 'locked.epub', makeEpub({ encrypted: true }), 'application/epub+zip');
  await expect(alert).toContainText('copy-protected');

  await pick(page, 'paper.pdf', strToU8('%PDF-1.7\n'), 'application/pdf');
  await expect(alert).toContainText('cannot be imported');
  await expect(alert).toContainText('PDF');

  // Nothing was stored and the sample is still on the page.
  await expect(importDialog(page).locator('.shelf li')).toHaveCount(0);
  await expect(page.locator('.book h1')).toHaveText('Pride and Prejudice');
});
