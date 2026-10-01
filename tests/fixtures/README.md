`ocr-column-geometry.json` preserves the text-item positions, widths, and
font sizes from six article pages of the reported two-column PDF. All source
text has been replaced with unique synthetic labels. The regression checks
that every label survives exactly once and that the complete left column
precedes the right column, including below the larger full-width abstract.

The fixture intentionally retains OCR font-size variation and baseline
jitter: replacing it with idealized rows would hide the original text-loss
and ordering bugs.
