{ runCommand, nodejs }:

runCommand "zotero-reader-tts-tests" {
  nativeBuildInputs = [ nodejs ];
} ''
  mkdir -p tests/fixtures
  cp ${../tests/reader-tts-text.test.cjs} tests/reader-tts-text.test.cjs
  cp ${../tests/reader-tts-seek.test.cjs} tests/reader-tts-seek.test.cjs
  cp ${../tests/reader-tts-follow.test.cjs} tests/reader-tts-follow.test.cjs
  cp ${../tests/fixtures/ocr-column-geometry.json} tests/fixtures/ocr-column-geometry.json
  export ZOTERO_TEST_TTS_SCRIPT=${../assets/reader-tts/reader-tts.js}
  node --check "$ZOTERO_TEST_TTS_SCRIPT"
  node --test tests/reader-tts-*.test.cjs
  touch $out
''
