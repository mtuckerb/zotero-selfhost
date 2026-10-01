# Attachment metadata and automatic parent items

The web-library patch in
`src/patches/web-library/0001-all-attachment-metadata-and-automatic-parent.patch`
enables Retrieve Metadata for every standalone attachment type in writable
libraries. Attachments already belonging to an item are excluded from creating
another parent, but their existing parent exposes **Refresh Metadata**.

Create Parent Item now offers **Automatic**, identifier entry, and **Manual
Entry**. Multiple selected attachments receive the same Automatic/Manual
choice instead of immediately creating empty records.

Refresh Metadata reruns discovery against the existing parent item's preferred
attachment, then shows every bibliographic difference in Current and New
columns before writing anything. New values for empty fields are selected by
default; replacements and removals keep the current value by default. Each
field can be selected independently, or **Use All New** can accept the complete
fresh result. Tags, collections, relations, notes, and attachments are never
offered for replacement and remain intact.

PDFs retain Zotero's recognizer. Before sending a PDF to it, explicit
identifiers in the attachment URL, title, or filename are resolved first. This
keeps a filename ISBN from losing to an incidental DOI found inside a full
book. When the recognizer returns only a title, with no creators or
bibliographic fields, embedded PDF title, author, subject, language, and
publisher fields produce a review-marked Document rather than an empty Journal
Article. EPUBs read the package declared in
`META-INF/container.xml`, including title, creators, publisher, publication
date, language, and ISBN. HTML reads citation metadata; DOCX and ODT read
embedded document metadata. Text files and other attachments can use
identifiers in the content, title, filename, or URL. Linked files use their
existing details because a browser cannot read local file paths.

Identifier lookups take priority, followed by embedded metadata. When neither
provides a match, a basic parent is created from the attachment's existing
title/filename and URL. The retrieval result explicitly labels embedded and
basic metadata for review. It does not guess missing authors or dates. Invalid
EPUBs and failed downloads produce errors and do not create parents.

When a file contains several identifiers, Retrieve Metadata compares the
returned titles with the document's embedded or attachment title and keeps the
closest match instead of accepting the first citation in extraction order.
Duplicate identifiers are queried only once, and an exact title match stops
the search early.

The attachment key, annotations, and tags stay intact. Collections move to
the parent. PDF/EPUB renaming preserves the original extension; other files
keep their names. Undo restores the standalone attachment. A rename failure
reports a completed parent with a warning, avoiding duplicate creation on retry.

The patch includes a pinned `fflate` dependency and focused regression tests.
In a web-library checkout at the pinned revision with the patch applied:

```sh
npm ci --ignore-scripts --legacy-peer-deps
npx jest test/attachment-metadata.test.js test/metadata-workflows.test.jsx test/recognize.test.jsx test/parent.test.jsx --runInBand
```

The weak-recognition regression was reproduced on 2026-09-29 with item
`CKIZ3TD2`: the upstream service returned HTTP 200 with a title but empty
authors and no identifier, and the old client stored exactly that sparse
result. The same batch showed a full-book filename ISBN being ignored in favor
of a chapter DOI. Regression tests now cover both cases.

Validation on 2026-10-01 covers preferred-attachment loading, stale refresh
previews, and fields that require an item-type change. The four focused Jest
suites pass all 38 tests inside the fixed-output production build, followed by
a successful reproducibility check and JavaScript/Sass build. The fixed-output
web library hash is `sha256-3xydMxs7d+lVX6cAdRlgh70uJkquKvOuYEKtmXoPbH8=`;
the verified configured bundle is
`/nix/store/16magzmmswms70gs76fmphfwfi1xfz3d-zotero-web-library-configured`.

Validation on 2026-09-29: all 33 focused tests passed, including selective and
complete refresh confirmation plus the existing PDF recognizer and parent-item
workflows. JavaScript and Sass production builds passed, and the patch applies
cleanly to the pinned source revision. The local candidate Nix bundle was built
successfully at
`/nix/store/y790kzgbr8hwwlgks54bll4h2cdmys8j-zotero-web-library-configured`
with output hash `sha256-Ph7pRiMZOQFDS0YzP+8eJg+wz6rTMzl6Q3I5Gt+gUyA=`;
it has not been deployed. Validation on 2026-09-25 additionally built the Nix
production bundle;
desktop and mobile Chromium tests using the actual *The Diving Bell and the Butterfly* EPUB
created the expected Book metadata through Automatic with mocked library
writes, retained `.epub`, and produced no browser errors. The production
library was not modified by these tests.

## Deployment

Deployed on 2026-09-25 with the web-library output hash
`sha256-viOlKMCyjaW59lvzpK6LEtIGCXK20/Vm5JdP6G53IBU=`.
Built SPA: `/nix/store/7azcsnn2sn1zdjkrafc98ch1gb7hx44z-zotero-web-library-configured`.

The rollout used `path:/etc/nixos` (the deployed configuration), updating
only its `zotero-selfhost` input. The same input node was merged into
`/data/nixos/flake.lock` without applying unrelated working-tree changes.
System closure comparison showed only the web-library package changing.
Previous system:
`/nix/store/i19f7pzp38ip76ldl6a2da4hsgsrk9hi-nixos-system-FederalNix-26.05.20260427.1c3fe55`.
New system:
`/nix/store/d6d0y3mbkb0z40n2sdi11qc9ms5ndl8p-nixos-system-FederalNix-26.05.20260427.1c3fe55`.
