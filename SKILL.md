---
name: zotero-word-citations-windows
description: Insert real Zotero live citation fields into Microsoft Word on Windows. Use when working with Zotero Desktop, Word .docx documents, Zotero Word plugin macros, local Zotero API localhost:23119, CSL styles, Zotero item keys/item IDs, or when a user asks Codex to add Zotero citations/references to Word rather than static text.
---

# Zotero Word Citations Windows

Use this skill to insert Zotero Word fields through Zotero's own Word integration. Do not synthesize Word field XML or insert plain citation text when the user asks for Zotero citations in Word.

## Workflow

1. Check readiness:

```powershell
python scripts/zotero_word_windows.py check
```

2. If the bridge endpoint is missing, install and register the local Zotero bridge, then restart Zotero:

```powershell
python scripts/zotero_word_windows.py install-bridge --register
```

3. Resolve a Zotero item key when needed:

```powershell
python scripts/zotero_word_windows.py resolve-key --key 426FR8FE
```

4. List installed CSL styles when a user gives a short or custom style name:

```powershell
python scripts/zotero_word_windows.py styles
```

5. Insert a live citation. With an active Word document, insertion occurs at the current cursor/selection:

```powershell
python scripts/zotero_word_windows.py insert --item-key 426FR8FE --style "APA Style 7th edition"
```

For a file path, prefer a marker placeholder so insertion is deterministic:

```powershell
python scripts/zotero_word_windows.py insert --docx "E:\Temp\paper.docx" --item-key 426FR8FE --style Myself --marker "{{ZOTERO_CITATION}}" --save --close
```

For a consecutive multi-reference citation, keep all items in one Zotero citation field. Do not insert separate fields and join their rendered text with manual semicolons. When the bridge supports an array payload, provide all Zotero item IDs in one citation request; when using the Word integration dialog, add the first item and then use `ZoteroAddEditCitation` on that same field so subsequent items are added through Zotero's citation dialog. The final field must contain the complete `citationItems` array, and Zotero must generate the punctuation and ordering.

Place the citation field immediately after the sentence or claim it supports, rather than appending all citations at the end of the paragraph. Use one marker per citation group, for example `{{CITATION_GROUP_1}}`, and replace that marker with one multi-item Zotero field.

The helper supports the reliable same-field workflow directly:

```powershell
python scripts/zotero_word_windows.py insert --docx "E:\Temp\paper.docx" --item-keys KEY1 KEY2 KEY3 --style Myself --marker "{{CITATION_GROUP_1}}" --save --close
```

This inserts the first item at the marker, then selects that resulting Zotero field and uses `ZoteroAddEditCitation` to add the remaining items to the same field. The current `inject-current-get` bridge route accepts one item per request; the final Word field is nevertheless a single Zotero citation field and its separators/order remain Zotero-managed. Do not use a loop that inserts separate fields at the marker and then writes semicolons between them.

If no marker is provided, the script opens the document and inserts at the end unless Word already has another active selection:

```powershell
python scripts/zotero_word_windows.py insert --docx "E:\Temp\paper.docx" --item-key 426FR8FE --style "APA Style 7th edition" --save --close
```

## Operating Notes

- Require Zotero Desktop with local API enabled, Microsoft Word desktop, and Zotero's Word plugin template loaded.
- The bridge is a local Zotero extension in `assets/zotero-codex-word-bridge`; the installer packages it as `codex-word-bridge@local.codex.xpi` under the active Zotero profile.
- The working Windows path is: call Word macro `Project.Zotero.ZoteroAddEditCitation`, then call Zotero bridge endpoint `/codex/zotero-word/inject-current-get` to fill the current Zotero integration dialog. Avoid the direct `/insert-get` path unless revalidating bridge internals.
- Style names are resolved against installed Zotero CSL files by style ID, title, filename, and file stem. The shorthand `Myself` resolves to `http://www.zotero.org/styles/Myself-AuthorYear` when that CSL is installed; use `styles` to inspect alternatives such as `Myself-NWAFU`.
- On first citation in a document, Zotero may open Document Preferences. The bridge accepts it and applies the requested style. If Quick Format does not appear immediately afterward, `insert` automatically retries once; pass `--no-retry-preferences` only when debugging that flow.
- After calling the Word macro, wait until the bridge reports `integrationDocPrefs.xhtml`, `quickFormat.xhtml`, or `citationDialog.xhtml`. Do not inject while `currentWindowURL` is `about:blank`; this transient state is a common cause of false failures.
- For grouped citations, select the existing Zotero field before calling `ZoteroAddEditCitation`; the Zotero 9 citation dialog appends the new item to that field. Reuse the first item's key to locate the field and save only after the complete group has been added.
- Word ownership safety: the helper first checks for an existing Word instance. If the requested document is already open there, it reuses that document and never closes the document or the user's Word application. If the document is not already open, it creates an isolated Word instance for the operation; `--close` closes and quits only that script-owned instance. Never use `Stop-Process -Name WINWORD` as cleanup because it can terminate the user's manually opened Word windows.
- If the same document is open in another Word instance that COM cannot identify, do not force-close Word. Ask the user to activate that document or close the duplicate instance, then retry; a file-lock or read-only error is safer than touching an unowned process.
- Use `--marker` for generated documents instead of relying on document-end insertion. The marker text is removed and replaced by the Zotero citation field.
- Use `--close` for file-based operations when the document was opened by the script; this reduces Word file locks during test-document generation.
- Before overwriting user documents, create a backup when the user asked for in-place file modification and the document is not a disposable test artifact.

## Useful Commands

Refresh citations in the active Word document:

```powershell
python scripts/zotero_word_windows.py refresh
```

Run a bridge status check only:

```powershell
python scripts/zotero_word_windows.py bridge-status
```

Use `--item-id` directly if the Zotero numeric `itemID` is already known. Use `--locator`, `--label`, `--prefix`, `--suffix`, and `--suppress-author` for citation details.
