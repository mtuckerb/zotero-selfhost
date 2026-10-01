/**
 * Kokoro read-aloud for the Zotero web library reader.
 *
 * Loaded as a plain <script> on the web-library SPA page (there is no build
 * step for this file — it ships as-is and is injected into index.html by
 * nix/module.nix). It adds two ways to hear a document:
 *
 *   - Select text in the reader  -> a "Read selection" button appears.
 *   - Press the toolbar button   -> reads the whole attachment.
 *
 * and a transport bar with previous/next part, +/- SEEK_STEP seconds,
 * play/pause, a scrub bar, a clock, and a speed selector.
 *
 * ---------------------------------------------------------------------------
 * Why this lives outside the reader bundle
 *
 * zotero/reader is fetched as a PREBUILT zip during the web-library build
 * (scripts/fetch-or-build-modules.mjs), so there is no source tree here to
 * patch. What makes an overlay workable anyway is that the reader runs in a
 * SAME-ORIGIN iframe (`/static/web-library/reader/reader.html`), so this
 * script can reach into `iframe.contentDocument` for selections without any
 * postMessage protocol. EPUB and snapshot views nest a further same-origin
 * iframe inside that one, hence the recursive frame walk below.
 *
 * Upstream zotero/reader has since grown its own read-aloud feature, but it
 * postdates the reader revision this deployment pins, and its remote voice
 * provider is Zotero's credit-metered cloud service rather than a local
 * engine. Neither is usable here.
 *
 * ---------------------------------------------------------------------------
 * Why each part is fetched whole rather than streamed
 *
 * The transport bar needs a real `duration` and working seeks. A progressively
 * streamed response gives `<audio>` neither: duration stays Infinity and
 * `currentTime` assignment is ignored, which would leave the scrub bar and the
 * +/-15s buttons inert. So each part is POSTed to Kokoro, buffered into a
 * Blob, and played from an object URL — fully seekable by construction. Parts
 * are kept small enough that time-to-first-audio stays short, and the NEXT
 * part is synthesized while the current one plays so playback runs continuous.
 */
(function () {
	'use strict';

	// ---------------------------------------------------------------- config

	function readJsonScript(id) {
		var el = document.getElementById(id);
		if (!el) return null;
		try {
			return JSON.parse(el.textContent);
		}
		catch (e) {
			return null;
		}
	}

	var CFG = readJsonScript('zotero-reader-tts-config') || {};
	var WL = readJsonScript('zotero-web-library-config') || {};

	/**
	 * Same-origin path that nginx proxies to the Kokoro server.
	 *
	 * Not `/tts` — the Zotero dataserver already owns that prefix for its own
	 * hosted read-aloud service, and nginx routes it there.
	 */
	var ENDPOINT = CFG.endpoint || '/reader-tts';
	var ALIGNMENT_ENDPOINT = CFG.alignmentEndpoint || null;
	var VOICE = CFG.voice || 'af_heart';
	var FORMAT = CFG.format || 'mp3';
	var SEEK_STEP = Number(CFG.seekStepSec) > 0 ? Number(CFG.seekStepSec) : 15;
	var SPEEDS = Array.isArray(CFG.speeds) && CFG.speeds.length
		? CFG.speeds
		: [0.75, 1, 1.25, 1.5, 1.75, 2];
	var HIGHLIGHT_STYLES = ['sentence', 'word', 'ball'];
	var DEFAULT_HIGHLIGHT_STYLE = HIGHLIGHT_STYLES.indexOf(CFG.highlightStyle) !== -1
		? CFG.highlightStyle
		: 'ball';
	var pronunciations = Object.create(null);
	var pronunciationConfig = CFG.pronunciations || { meso: 'mˈɛzO' };
	Object.keys(pronunciationConfig).forEach(function (word) {
		var phonemes = pronunciationConfig[word];
		if (typeof phonemes === 'string' && phonemes.trim() && !/[\/()[\]\r\n]/u.test(phonemes)) {
			pronunciations[word.toLowerCase()] = phonemes.trim();
		}
	});

	/**
	 * Characters per synthesized part.
	 *
	 * The ceiling is a latency/seam tradeoff, not a server limit: a part must
	 * finish synthesizing before the previous one runs out or playback stalls
	 * at the boundary, and the FIRST part is dead air for the user. Kokoro
	 * runs comfortably faster than realtime, so ~1500 characters (roughly a
	 * minute and a half of speech) starts in a couple of seconds and leaves
	 * ample headroom to prefetch the next part.
	 */
	var CHUNK_MAX_CHARS = Number(CFG.chunkMaxChars) > 0
		? Number(CFG.chunkMaxChars)
		: 1500;

	var SPEED_STORAGE_KEY = 'zotero-reader-tts-speed';
	var VOICE_STORAGE_KEY = 'zotero-reader-tts-voice';
	var HIGHLIGHT_STORAGE_KEY = 'zotero-reader-tts-highlight';
	var PROGRESS_STORAGE_PREFIX = 'zotero-reader-tts-progress';
	var MIN_SPEED = 0.25;
	var MAX_SPEED = 4;

	if (CFG.enabled === false) return;

	// --------------------------------------------------------------- helpers

	/**
	 * Split text at natural boundaries. Paragraph breaks are preferred, then
	 * sentence ends, then any whitespace — so a part boundary lands somewhere
	 * the ear expects a pause, and "next part" lands on prose.
	 */
	function splitTextForSpeech(text, maxChars) {
		var rest = String(text || '').trim();
		var chunks = [];
		if (!rest || maxChars < 1) return chunks;
		while (rest.length > maxChars) {
			var cut = rest.lastIndexOf('\n\n', maxChars);
			if (cut < maxChars / 2) cut = rest.lastIndexOf('. ', maxChars);
			if (cut < maxChars / 2) cut = rest.lastIndexOf(' ', maxChars);
			if (cut < 1) cut = maxChars;
			var chunk = rest.slice(0, cut).trim();
			if (chunk) chunks.push(chunk);
			rest = rest.slice(cut).trim();
		}
		if (rest) chunks.push(rest);
		return chunks;
	}

	/**
	 * Clean up text pulled out of a PDF text layer or the full-text index.
	 *
	 * Both sources preserve the printed line breaks, which means words are
	 * split across lines by a hyphen and sentences are broken mid-clause.
	 * Spoken verbatim that produces audible stutters ("hy- phenation"), so
	 * rejoin hyphenated line breaks, fold remaining single newlines into
	 * spaces, and keep blank lines as the paragraph breaks the splitter wants.
	 */
	function normalizeForSpeech(text) {
		var lines = String(text || '').replace(/\r\n?|[\f\u0085\u2028\u2029]/g, '\n');
		// Full-text for Markdown attachments retains ATX heading markers. Strip
		// the markup and put a sentence/paragraph boundary after the heading so
		// the voice does not run it into the first sentence of the section.
		lines = lines.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/gm, function (_line, heading) {
			heading = heading.trim();
			if (!/[.!?…:;]$/.test(heading)) heading += '.';
			return '\n' + heading + '\n';
		});
		return cleanCitationsForSpeech(pruneBoilerplateLines(lines))
			// PDF/OCR can separate the final hyphen from its word with spaces.
			// Require a line break for visible hyphens; keep within-line compounds.
			// Look ahead at the next letter so successive wraps (re-\na-\nlignment)
			// can share a one-letter fragment without skipping the second hyphen.
			.replace(/([\p{L}\p{M}])[^\S\n]*[-\u00AD\u2010][^\S\n]*\n\s*(?=\p{L})/gu, '$1')
			// Discretionary soft hyphens are formatting even without a line break.
			.replace(/\u00AD/g, '')
			// Collapse runs of blank lines to exactly one paragraph break.
			.replace(/\n{2,}/g, '\n\n')
			// A lone newline is a line wrap, not a sentence end.
			.replace(/([^\n])\n([^\n])/g, '$1 $2')
			.replace(/[ \t\u00A0]+/g, ' ')
			.trim();
	}

	function cleanCitationsForSpeech(text) {
		return String(text || '')
			// Numeric citations: [4], [12, 13], [2-5].
			.replace(/\[\s*\d{1,4}(?:\s*(?:,|;|-|–|—)\s*\d{1,4})*\s*\]/g, ' citation ')
			// Require a recognizable author-year shape, not merely a year:
			// dates and ordinary explanations in parentheses are spoken.
			.replace(/\((?:(?!(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b)[A-Z][A-Za-z'\u2019-]+(?:\s+(?:&|and)\s+[A-Z][A-Za-z'\u2019-]+|\s+et\s+al\.)?,\s*(?:18|19|20)\d{2}[a-z]?(?:,\s*p{1,2}\.\s*\d+(?:[–-]\d+)?)?)(?:;\s*(?!(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b)[A-Z][A-Za-z'\u2019-]+(?:\s+(?:&|and)\s+[A-Z][A-Za-z'\u2019-]+|\s+et\s+al\.)?,\s*(?:18|19|20)\d{2}[a-z]?)*\)/g, ' citation ')
			// Common inline forms like "Smith et al. (2020)".
			.replace(/\b(?!(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b)[A-Z][A-Za-z'\u2019-]+(?:\s+et\s+al\.)?\s+\((?:18|19|20)\d{2}[a-z]?\)/g, 'citation');
	}

	function pruneBoilerplateLines(text) {
		var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
		var out = [];
		var singleRun = 0;
		lines.forEach(function (line) {
			var trimmed = line.trim();
			if (isPublisherNotice(trimmed)) return;
			var isSingle = /^[A-Za-z]$/.test(trimmed);
			singleRun = isSingle ? singleRun + 1 : 0;
			if (/^\d{1,4}$/.test(trimmed)) return;
			// Repetition alone does not make prose a header. PDF running heads
			// are recognized at page edges before text is flattened.
			if (/^[A-Za-z](?:\s+[A-Za-z]){3,}$/.test(trimmed)) return;
			if (isSingle && singleRun >= 4) {
				while (out.length && /^[A-Za-z]$/.test(out[out.length - 1].trim())) out.pop();
				return;
			}
			out.push(line);
		});
		return out.join('\n');
	}

	function isPublisherNotice(text) {
		return /^(?:EBSCO(?:host| Publishing)\b|(?:\d{4}[.,]?\s*)?(?:Columbia University Press[.,]?\s*)?All rights reserved\b|(?:\d{4}[.,]?\s*)?Columbia University Press\.?$|Work Interview Account:\s*ehost\b)/i.test(text.trim());
	}

	function formatClock(seconds) {
		if (!isFinite(seconds) || seconds < 0) return '0:00';
		var total = Math.floor(seconds);
		var m = Math.floor(total / 60);
		var s = total % 60;
		return m + ':' + (s < 10 ? '0' : '') + s;
	}

	function clampSpeed(value) {
		var n = Number(value);
		if (!isFinite(n)) return 1;
		return Math.min(MAX_SPEED, Math.max(MIN_SPEED, n));
	}

	function loadSpeed() {
		try {
			var stored = localStorage.getItem(SPEED_STORAGE_KEY);
			return stored === null ? 1 : clampSpeed(stored);
		}
		catch (e) {
			// Private browsing / blocked storage: 1x is a fine default.
			return 1;
		}
	}

	function saveSpeed(speed) {
		try {
			localStorage.setItem(SPEED_STORAGE_KEY, String(speed));
		}
		catch (e) { /* not worth breaking playback over */ }
	}

	/** The configured voice is the default; a per-browser choice overrides it. */
	function loadVoice() {
		try {
			return localStorage.getItem(VOICE_STORAGE_KEY) || VOICE;
		}
		catch (e) {
			return VOICE;
		}
	}

	function saveVoice(v) {
		try {
			localStorage.setItem(VOICE_STORAGE_KEY, v);
		}
		catch (e) { /* not worth breaking playback over */ }
	}

	function loadHighlightStyle() {
		try {
			var stored = localStorage.getItem(HIGHLIGHT_STORAGE_KEY);
			return HIGHLIGHT_STYLES.indexOf(stored) !== -1 ? stored : DEFAULT_HIGHLIGHT_STYLE;
		}
		catch (e) {
			return DEFAULT_HIGHLIGHT_STYLE;
		}
	}

	function saveHighlightStyle(style) {
		try {
			localStorage.setItem(HIGHLIGHT_STORAGE_KEY, style);
		}
		catch (e) { /* read-along still works without persisted preference */ }
	}

	function isDocumentSource(source) {
		return source === 'document';
	}

	function isDocumentRun(theRun) {
		return !!(theRun && isDocumentSource(theRun.source) && theRun.progressKey);
	}

	function textHash(text) {
		var hash = 2166136261;
		var s = String(text || '');
		for (var i = 0; i < s.length; i++) {
			hash ^= s.charCodeAt(i);
			hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
		}
		return (hash >>> 0).toString(36) + ':' + s.length;
	}

	function progressStorageKey(attachment, source) {
		if (!attachment || !isDocumentSource(source)) return null;
		return PROGRESS_STORAGE_PREFIX + ':' + (WL.userId || 'user') + ':' + attachment + ':' + source;
	}

	function loadReadProgress(attachment, source, normalizedText, partCount) {
		var key = progressStorageKey(attachment, source);
		if (!key) return null;
		try {
			var stored = JSON.parse(localStorage.getItem(key) || 'null');
			var hash = textHash(normalizedText);
			if (!stored || stored.version !== 1 || stored.hash !== hash) return null;
			var index = Math.max(0, Math.floor(Number(stored.index || 0)));
			var seconds = Math.max(0, Number(stored.seconds || 0));
			var startWord = Math.max(0, Math.floor(Number(stored.startWord || 0)));
			if (!isFinite(seconds) || !isFinite(startWord) || index >= partCount) return null;
			return { index: index, seconds: seconds, startWord: startWord };
		}
		catch (e) {
			return null;
		}
	}

	function clearReadProgress(theRun) {
		if (!isDocumentRun(theRun)) return;
		try {
			localStorage.removeItem(theRun.progressKey);
		}
		catch (e) { /* progress is a convenience, not playback-critical */ }
	}

	function saveReadProgress(force) {
		if (!isDocumentRun(run) || !audio || !audio.src) return;
		var part = run.parts[run.index];
		if (!part || audio.src !== part.url) return;
		var now = Date.now();
		if (!force && now - (run.progressSavedAt || 0) < 5000) return;
		var seconds = Math.max(0, Number(audio.currentTime || 0));
		if (!isFinite(seconds)) return;
		try {
			localStorage.setItem(run.progressKey, JSON.stringify({
				version: 1,
				attachment: run.attachmentKey,
				source: run.source,
				hash: run.textHash,
				index: run.index,
				seconds: seconds,
				startWord: part.startWord || 0,
				updatedAt: now
			}));
			run.progressSavedAt = now;
		}
		catch (e) { /* progress is a convenience, not playback-critical */ }
	}

	function readAlongTokens(text) {
		var segments = String(text || '').match(/\S+|\s+/g) || [];
		var words = [];
		var pieces = [];
		segments.forEach(function (segment) {
			if (/^\s+$/.test(segment)) {
				pieces.push({ text: segment, wordIndex: null });
				return;
			}
			var index = words.length;
			words.push(segment);
			pieces.push({ text: segment, wordIndex: index });
		});
		return { pieces: pieces, words: words, wordEls: [] };
	}

	function sentenceRangeForWord(words, activeIndex) {
		if (activeIndex < 0 || activeIndex >= words.length) return null;
		var endsSentence = function (word) {
			return /[.!?]["'’”»\])}]*$/u.test(word);
		};
		var start = activeIndex;
		while (start > 0 && !endsSentence(words[start - 1])) start -= 1;
		var end = activeIndex;
		while (end < words.length - 1 && !endsSentence(words[end])) end += 1;
		return { start: start, end: end };
	}

	function normalizeTimeline(raw) {
		if (!Array.isArray(raw)) return [];
		return raw.map(function (item) {
			var wordIndex = Array.isArray(item) ? item[0] : item.wordIndex;
			var startMs = Array.isArray(item)
				? item[1]
				: (item.startMs !== undefined ? item.startMs : item.start);
			var endMs = Array.isArray(item)
				? item[2]
				: (item.endMs !== undefined ? item.endMs : item.end);
			var confidence = Array.isArray(item) ? item[3] : item.confidence;
			wordIndex = Number(wordIndex);
			startMs = Number(startMs);
			endMs = Number(endMs);
			confidence = confidence === undefined ? 1 : Number(confidence);
			if (!isFinite(wordIndex) || !isFinite(startMs) || !isFinite(endMs)) return null;
			return [
				Math.max(0, Math.floor(wordIndex)),
				Math.max(0, Math.round(startMs)),
				Math.max(Math.round(startMs) + 1, Math.round(endMs)),
				isFinite(confidence) ? confidence : 1
			];
		}).filter(Boolean).sort(function (a, b) {
			return a[0] - b[0] || a[1] - b[1];
		});
	}

	function activeWordForPart(part, seconds) {
		var timeline = part && part.timeline;
		if (!timeline || !timeline.length) return -1;
		var positionMs = Math.max(0, Number(seconds || 0) * 1000);
		var low = 0;
		var high = timeline.length;
		while (low < high) {
			var middle = (low + high) >> 1;
			if (timeline[middle][1] <= positionMs) low = middle + 1;
			else high = middle;
		}
		if (low === 0) return positionMs + 750 >= timeline[0][1] ? timeline[0][0] : -1;
		var previous = timeline[Math.min(timeline.length - 1, low - 1)];
		var next = timeline[low];
		if (positionMs <= previous[2] + 750) return previous[0];
		if (next && positionMs + 250 >= next[1]) return next[0];
		return -1;
	}

	function timeForWord(part, wordIndex) {
		var timeline = part && part.timeline;
		if (!timeline || !timeline.length) return null;
		for (var i = 0; i < timeline.length; i++) {
			if (timeline[i][0] === wordIndex) return timeline[i][1] / 1000;
			if (timeline[i][0] > wordIndex) break;
		}
		return null;
	}

	function blobToBase64(blob) {
		return new Promise(function (resolve, reject) {
			var reader = new FileReader();
			reader.onload = function () {
				var result = String(reader.result || '');
				var comma = result.indexOf(',');
				resolve(comma === -1 ? result : result.slice(comma + 1));
			};
			reader.onerror = function () {
				reject(reader.error || new Error('Could not read audio for alignment'));
			};
			reader.readAsDataURL(blob);
		});
	}

	/**
	 * Human label for a Kokoro voice id.
	 *
	 * Ids are `<lang><gender>_<name>`: `af_heart` is American English, female,
	 * "heart". Grouping by that prefix turns a flat list of ~68 into something
	 * scannable; anything with an unrecognised prefix still shows, under Other,
	 * rather than being hidden.
	 */
	var VOICE_LANGS = {
		a: 'American English', b: 'British English', e: 'Spanish', f: 'French',
		h: 'Hindi', i: 'Italian', j: 'Japanese', p: 'Portuguese', z: 'Chinese'
	};

	function voiceGroup(id) {
		var m = /^([a-z])([fm])_/.exec(id);
		if (!m || !VOICE_LANGS[m[1]]) return 'Other';
		return VOICE_LANGS[m[1]] + ' · ' + (m[2] === 'f' ? 'Female' : 'Male');
	}

	function voiceLabel(id) {
		var m = /^[a-z][fm]_(.+)$/.exec(id);
		var name = m ? m[1] : id;
		return name.charAt(0).toUpperCase() + name.slice(1);
	}

	function el(tag, className, attrs) {
		var node = document.createElement(tag);
		if (className) node.className = className;
		for (var k in attrs || {}) node.setAttribute(k, attrs[k]);
		return node;
	}

	// ------------------------------------------------------------ synthesis

	/**
	 * English Kokoro phoneme overrides belong only in the synthesis request.
	 * Keep the source words for display, click-to-seek, and forced alignment.
	 * Match whole words (also before a hyphen), never prefixes of longer words.
	 */
	function applyPronunciations(text) {
		if (!/^[ab][fm]_/u.test(voice)) return text;
		return text.replace(/[\p{L}\p{M}\p{N}_]+/gu, function (word) {
			var phonemes = pronunciations[word.toLowerCase()];
			return phonemes ? '[' + word + '](/' + phonemes + '/)' : word;
		});
	}

	/**
	 * Synthesize one part. Resolves to an object URL for a fully buffered,
	 * seekable audio Blob.
	 *
	 * `speed` is deliberately pinned at 1 here and applied on the element as
	 * `playbackRate` instead: re-rendering audio on every speed change would
	 * cost a synthesis round trip and restart the part, whereas playbackRate
	 * takes effect on the currently playing buffer instantly.
	 */
	function synthesize(text, signal) {
		return fetch(ENDPOINT + '/v1/audio/speech', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'kokoro',
				voice: voice,
				input: applyPronunciations(text),
				response_format: FORMAT,
				speed: 1
			}),
			// The endpoint may sit behind an nginx auth_request gate that reads
			// the deployment's session cookie. Same-origin is fetch's default,
			// but state it: without the cookie such a gate answers 401 and no
			// audio is ever produced.
			credentials: 'same-origin',
			signal: signal
		}).then(function (response) {
			if (!response.ok) {
				return response.text().catch(function () { return ''; })
					.then(function (body) {
						throw new Error(
							response.status === 502 || response.status === 504
								? 'Kokoro is unreachable'
								: response.status === 404
									? 'TTS endpoint not configured'
									: (response.status === 401 || response.status === 403)
										// An auth_request gate rejected us: the session
										// behind it lapsed while the tab stayed open.
										? 'Session expired — reload the page to read aloud'
										: (body || 'TTS failed (HTTP ' + response.status + ')')
						);
					});
			}
			return response.blob().then(function (blob) {
				return { blob: blob, contentType: response.headers.get('content-type') || blob.type || '' };
			});
		}).then(function (result) {
			return {
				blob: result.blob,
				contentType: result.contentType,
				url: URL.createObjectURL(result.blob)
			};
		});
	}

	// -------------------------------------------------------------- the run
	//
	// One "run" is a single read job: an ordered list of parts plus the index
	// of the part currently loaded. Everything the transport bar does is a
	// mutation of the live run.

	var run = null;
	var documentReadRequest = 0;
	var pdfSpeechCache = new WeakMap();
	var pdfSurfaceCache = new WeakMap();
	var epubSurfaceCache = new WeakMap();
	var audio = null;
	var speed = loadSpeed();
	var voice = loadVoice();
	var highlightStyle = loadHighlightStyle();
	var surfacePaint = null;
	var SURFACE_STYLE_ID = 'ztts-surface-style';
	var SURFACE_STYLE_TEXT = [
		'.ztts-surface-layer{position:fixed;inset:0;z-index:2147483000;pointer-events:none;overflow:hidden;}',
		'.ztts-surface-mark{position:absolute;box-sizing:border-box;border-radius:4px;transform:translateZ(0);transition:left 180ms ease,top 180ms ease,width 180ms ease,height 180ms ease,opacity 120ms ease;}',
		'.ztts-surface-mark.word-spoken{background:rgba(240,185,90,.5);box-shadow:0 0 0 2px rgba(240,185,90,.38);}',
		'.ztts-surface-mark.sentence-spoken{background:rgba(65,90,72,.16);box-shadow:0 0 0 1px rgba(65,90,72,.08);}',
		'.ztts-surface-mark.ball-active{background:rgba(240,185,90,.22);}',
		'.ztts-surface-ball{position:absolute;left:0;top:0;width:0;height:0;will-change:transform;transition:transform 240ms cubic-bezier(.22,.61,.36,1);}',
		'.ztts-surface-ball::before{content:"";position:absolute;left:0;top:0;width:10px;height:10px;border-radius:50%;background:#b6572c;box-shadow:0 2px 5px rgba(32,35,31,.28);animation:ztts-ball-bounce 720ms cubic-bezier(.37,0,.63,1) infinite;}',
		'@keyframes ztts-ball-bounce{0%,100%{transform:translate(-50%,-125%) scale(1,.94);}50%{transform:translate(-50%,-215%) scale(.96,1.05);}}',
		'@media (prefers-reduced-motion:reduce){.ztts-surface-mark,.ztts-surface-ball{transition:none;}.ztts-surface-ball::before{animation:none;}}'
	].join('\n');

	function ensureAudio() {
		if (audio) return audio;
		audio = new Audio();
		audio.preload = 'auto';
		audio.addEventListener('playing', function () {
			setPhase('playing');
			prefetchNext();
		});
		audio.addEventListener('pause', function () {
			// Swapping src between parts also fires `pause`; only a genuine
			// user pause on loaded media should flip the glyph.
			if (!run || run.loading || audio.ended || !audio.src) return;
			saveReadProgress(true);
			setPhase('paused');
		});
		audio.addEventListener('ended', function () {
			if (!run || run.loading || !audio.src || audio.src !== run.parts[run.index].url) return;
			run.pendingSeek = null;
			playPart(run.index + 1, true);
		});
		audio.addEventListener('loadedmetadata', function () {
			// Re-pin after the load algorithm has run, so the rate holds even
			// if a browser restores it differently than the spec describes.
			applyRate(audio);
			applyPendingSeek();
			syncScrubRange();
		});
		audio.addEventListener('durationchange', syncScrubRange);
		audio.addEventListener('timeupdate', paintProgress);
		audio.addEventListener('error', function () {
			if (!run || !audio.src) return;
			setError('Audio playback failed');
		});
		return audio;
	}

	/**
	 * Pin the element's playback rate.
	 *
	 * Sets BOTH properties, deliberately. `load()` resets `playbackRate` to
	 * `defaultPlaybackRate` as part of the media load algorithm, so a rate
	 * assigned before a load is silently discarded — which made the chosen
	 * speed apply only to the part it was changed on and revert to 1x on every
	 * part after it, and on every later reading. `defaultPlaybackRate` is what
	 * carries the choice across loads.
	 */
	function applyRate(el) {
		if (!el) return;
		el.defaultPlaybackRate = speed;
		el.playbackRate = speed;
	}

	/** Drop a part's object URL once it can no longer be replayed. */
	function releasePart(part) {
		if (part && part.url) {
			URL.revokeObjectURL(part.url);
			part.url = null;
		}
		if (part) part.blob = null;
	}

	function alignPart(theRun, index, blob) {
		if (!ALIGNMENT_ENDPOINT || !blob) return;
		var part = theRun.parts[index];
		if (!part || part.timeline || part.alignPending) return;
		var signal = theRun.controller.signal;
		var isCurrent = function () {
			return run === theRun && theRun.parts[index] === part && !signal.aborted;
		};
		part.alignmentError = null;
		part.alignPending = blobToBase64(blob).then(function (audioBase64) {
			if (!isCurrent()) throw new Error('cancelled');
			return fetch(ALIGNMENT_ENDPOINT.replace(/\/$/u, '') + '/v1/audio/align', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					text: part.speechText,
					audio: audioBase64,
					format: FORMAT,
					mimeType: blob.type || part.contentType || 'application/octet-stream'
				}),
				credentials: 'same-origin',
				signal: signal
			});
		});
		renderAlignStatus();
		part.alignPending = part.alignPending.then(function (response) {
			if (!response.ok) {
				return response.text().catch(function () { return ''; })
					.then(function (body) {
						var message = body;
						try {
							var parsed = JSON.parse(body);
							message = parsed && (parsed.error || parsed.message) || message;
						}
						catch (e) { /* plain text body */ }
						throw new Error(message || 'Forced alignment failed');
					});
			}
			return response.json();
		}).then(function (body) {
			if (!isCurrent()) throw new Error('cancelled');
			var timeline = normalizeTimeline(body && body.timeline);
			if (!timeline.length) throw new Error('No word timings returned');
			timeline.forEach(function (entry) { entry[0] += part.startWord; });
			part.timeline = timeline;
			part.alignment = body;
			part.blob = null;
			if (run === theRun && theRun.index === index) {
				renderAlignStatus();
				paintHighlight(true);
			}
			return timeline;
		}).catch(function (err) {
			if (err && (err.name === 'AbortError' || err.message === 'cancelled')) return null;
			part.alignmentError = err && err.message ? err.message : 'Forced alignment failed';
			return null;
		}).then(function (timeline) {
			if (part.alignPending) part.alignPending = null;
			if (run === theRun && theRun.index === index) renderAlignStatus();
			return timeline;
		});
	}

	function stopRun(completed) {
		documentReadRequest++;
		if (run) {
			cancelSurfaceScroll();
			if (completed) clearReadProgress(run);
			else saveReadProgress(true);
			run.controller.abort();
			run.parts.forEach(releasePart);
		}
		run = null;
		clearSurfaceHighlight();
		if (audio) {
			audio.pause();
			audio.removeAttribute('src');
			audio.load();
		}
		hideBar();
	}

	/** Synthesize `index` if it has not been synthesized already. */
	function loadPart(theRun, index) {
		var part = theRun.parts[index];
		if (!part) return Promise.reject(new Error('No such part'));
		if (part.url) {
			if (part.blob && !part.timeline && !part.alignPending) alignPart(theRun, index, part.blob);
			return Promise.resolve(part.url);
		}
		if (part.pending) return part.pending;
		var signal = theRun.controller.signal;
		part.pending = synthesize(part.speechText, signal)
			.then(function (result) {
				part.pending = null;
				// A run that was stopped mid-flight must not leak its blob.
				if (run !== theRun || theRun.parts[index] !== part || signal.aborted) {
					URL.revokeObjectURL(result.url);
					throw new Error('cancelled');
				}
				part.url = result.url;
				part.blob = result.blob;
				part.contentType = result.contentType;
				alignPart(theRun, index, result.blob);
				return result.url;
			}, function (err) {
				part.pending = null;
				throw err;
			});
		return part.pending;
	}

	/**
	 * Release the audio for parts well behind the playhead.
	 *
	 * A long attachment can run to a hundred parts, and holding every
	 * synthesized MP3 for the life of the run would grow to hundreds of
	 * megabytes of blobs. Keeping a couple of parts either side of the
	 * playhead is enough for "previous part" and a backwards seek to be
	 * instant; anything further back is re-synthesized if the user goes there.
	 */
	function pruneParts(theRun, index) {
		theRun.parts.forEach(function (part, i) {
			if (i < index - 1 || i > index + 2) releasePart(part);
		});
	}

	/** Warm the next part so playback does not stall at the boundary. */
	function prefetchNext() {
		if (!run) return;
		var next = run.index + 1;
		if (next >= run.parts.length) return;
		var theRun = run;
		loadPart(theRun, next).catch(function () {
			// A prefetch failure is not surfaced; the real load will report it.
		});
	}

	/**
	 * Load part `index` and optionally start it. An out-of-range index is the
	 * exit edge — "next" on the final part ends the job.
	 */
	function playPart(index, autoplay) {
		if (!run) return;
		if (index < 0 || index >= run.parts.length) {
			stopRun(true);
			return;
		}
		if (audio && audio.src) saveReadProgress(true);
		var theRun = run;
		var previousIndex = theRun.index;
		var previous = theRun.parts[previousIndex];
		var request = {};
		theRun.playRequest = request;
		theRun.autoplay = autoplay;
		theRun.index = index;
		theRun.loading = true;
		theRun.failed = null;
		// Stop the old clip immediately. Its events must not advance the new
		// part or overwrite its saved position while synthesis is pending.
		if (audio) {
			audio.pause();
			audio.removeAttribute('src');
			audio.load();
		}
		// A clip generated from a clicked word is only for that visit. After
		// leaving it, later sequential playback must read the complete part.
		if (previousIndex !== index && previous.startWord) {
			theRun.parts[previousIndex] = createPart(previous.text);
			releasePart(previous);
		}
		setPhase('loading');
		renderMeta();
		renderFollow();
		loadPart(theRun, index).then(function (url) {
			if (run !== theRun || theRun.playRequest !== request) return;
			var a = ensureAudio();
			// Prune BEFORE adopting the new src so the URL now playing is
			// never the one being revoked.
			pruneParts(theRun, index);
			a.src = url;
			applyRate(a);
			a.load();
			if (!autoplay) {
				theRun.loading = false;
				setPhase('paused');
				return;
			}
			var started = a.play();
			if (started && started.then) {
				started.catch(function (err) {
					if (run !== theRun || theRun.playRequest !== request) return;
					// Autoplay policy: the first part always follows a click,
					// so this only fires in odd cases. Leave it paused and
					// let the user press play.
					setPhase('paused');
					setError(err && err.name === 'NotAllowedError'
						? 'Press play to start audio'
						: 'Audio playback failed');
				});
			}
		}).catch(function (err) {
			if (run !== theRun || theRun.playRequest !== request) return;
			if (err && (err.name === 'AbortError' || err.message === 'cancelled')) return;
			// Drop the previous part's clip. Left loaded, the element keeps it
			// in its `ended` state and Play would replay THAT — the wrong part,
			// under the failed part's label — after which `ended` would advance
			// past the part that never played, losing it silently.
			theRun.failed = index;
			if (audio) {
				audio.pause();
				audio.removeAttribute('src');
				audio.load();
			}
			setError(err && err.message ? err.message : 'TTS failed');
		}).then(function () {
			if (run === theRun && theRun.playRequest === request) theRun.loading = false;
		});
	}

	function createPart(text, startWord) {
		var words = text.match(/\S+\s*/g) || [];
		startWord = Math.min(Math.max(0, startWord || 0), Math.max(0, words.length - 1));
		return {
			text: text,
			// Keep the complete part for matching and backwards jumps. If no
			// timings exist, synthesize exactly from the requested word.
			startWord: startWord,
			speechText: words.slice(startWord).join('').trim(),
			url: null,
			blob: null,
			contentType: null,
			pending: null,
			timeline: null,
			alignPending: null,
			alignmentError: null,
			readAlong: null,
			activeWord: -1
		};
	}

	/**
	 * Start reading `text`. Re-invoking with the same source toggles the job
	 * off, which is what makes the two entry-point buttons act as toggles.
	 */
	function startRun(source, text, options) {
		options = options || {};
		var normalized = normalizeForSpeech(text);
		var key = source + ':' + normalized;
		var chunks = splitTextForSpeech(normalized, CHUNK_MAX_CHARS);
		var initial = options.surfaceHit && runPositionForSurfaceToken(
			options.surfaceHit.tokens, options.surfaceHit.tokenIndex,
			{ parts: chunks.map(function (chunk) { return createPart(chunk); }) }
		);
		if (options.surfaceHit && !initial) return false;
		if (run && run.key === key && !initial) {
			stopRun();
			return;
		}
		stopRun();
		if (!chunks.length) {
			showBar();
			setError('Nothing to read');
			return;
		}
		var attachment = options.attachmentKey || null;
		var progress = initial ? null : loadReadProgress(attachment, source, normalized, chunks.length);
		run = {
			key: key,
			source: source,
			attachmentKey: attachment,
			progressKey: progressStorageKey(attachment, source),
			textHash: textHash(normalized),
			progressSavedAt: 0,
			index: initial ? initial.partIndex : (progress ? progress.index : 0),
			loading: false,
			surfaceFollowing: true,
			surfaceScroll: null,
			// Set by seekBy when a +/- step runs off the end of a part; applied
			// once the part it lands in reports a duration.
			pendingSeek: null,
			// Index of a part whose synthesis failed, so Play can retry it.
			failed: null,
			controller: new AbortController(),
			parts: chunks.map(function (t, index) {
				if (initial && initial.partIndex === index) return createPart(t, initial.wordIndex);
				return createPart(t, progress && progress.index === index ? progress.startWord : 0);
			})
		};
		renderSurfaceFollow();
		if (progress && progress.seconds > 0) {
			run.pendingSeek = { fromEnd: false, seconds: progress.seconds };
		}
		showBar();
		setError(null);
		playPart(run.index, options.autoplay !== false);
		return true;
	}

	// ---------------------------------------------------- transport controls

	function togglePlay() {
		if (!run) return;
		// A part whose synthesis failed left nothing loaded. Play then means
		// "try that part again" — the useful action after a transient Kokoro
		// error — rather than doing nothing, or replaying a neighbouring part.
		if (run.failed !== null) {
			var retry = run.failed;
			run.failed = null;
			playPart(retry, true);
			return;
		}
		if (!audio || !audio.src) return;
		if (audio.paused) audio.play().catch(function () {});
		else audio.pause();
	}

	/**
	 * Seek within the current part, spilling into the neighbouring part when
	 * the step runs off either end — so +/-15s keeps working across a part
	 * boundary instead of dead-ending at 0:00 or the last frame.
	 *
	 * The leftover is carried into the part we land in rather than dropped:
	 * parts are an artefact of how the audio is synthesized, not something the
	 * listener chose, so rewinding 15s across a boundary should land 15s back
	 * in the document — not at the start of the previous part, which could be
	 * a minute earlier.
	 */
	function seekBy(delta) {
		if (!run || !audio) return;
		var target = audio.currentTime + delta;
		var duration = isFinite(audio.duration) ? audio.duration : 0;
		if (target < 0) {
			if (run.index === 0) {
				audio.currentTime = 0;
				saveReadProgress(true);
				return;
			}
			// `target` is negative: that many seconds before the previous
			// part's end. Its duration is not known until it loads.
			run.pendingSeek = { fromEnd: true, seconds: -target };
			playPart(run.index - 1, !audio.paused);
			return;
		}
		if (duration > 0 && target > duration) {
			run.pendingSeek = { fromEnd: false, seconds: target - duration };
			playPart(run.index + 1, !audio.paused);
			return;
		}
		audio.currentTime = duration > 0 ? Math.min(target, duration) : target;
		saveReadProgress(true);
	}

	/**
	 * Apply a seek that was queued before the part it targets had loaded.
	 * Runs on `loadedmetadata`, the first point at which a duration exists.
	 */
	function applyPendingSeek() {
		if (!run || !run.pendingSeek || !audio) return;
		if (audio.src !== run.parts[run.index].url) return;
		var duration = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
		if (!duration) return;
		var pending = run.pendingSeek;
		run.pendingSeek = null;
		var at = pending.fromEnd ? duration - pending.seconds : pending.seconds;
		audio.currentTime = Math.min(duration, Math.max(0, at));
		saveReadProgress(true);
	}

	/**
	 * Previous part, or restart this one when we are already a few seconds in
	 * — the behaviour every music player has trained people to expect.
	 */
	function previousPart() {
		if (!run || !audio) return;
		if (audio.currentTime > 3 || run.index === 0) {
			audio.currentTime = 0;
			saveReadProgress(true);
			return;
		}
		run.pendingSeek = null;
		playPart(run.index - 1, !audio.paused);
	}

	function nextPart() {
		if (!run) return;
		run.pendingSeek = null;
		playPart(run.index + 1, !(audio && audio.paused));
	}

	/**
	 * Switch voice, re-synthesizing from where we are.
	 *
	 * Unlike speed -- which is `playbackRate` on the buffer already loaded, so
	 * it applies instantly -- a voice change means every clip is wrong. Both
	 * the parts already fetched AND any fetch still in flight would resolve in
	 * the previous voice, so the run's parts are reset and its AbortController
	 * replaced. Playback resumes at the same offset in the same part, so
	 * switching voice does not lose the reader's place.
	 */
	function applyVoice(next) {
		if (!next || next === voice) return;
		voice = next;
		saveVoice(voice);
		if (ui.voice) ui.voice.value = voice;
		if (!run) return;
		var at = audio && isFinite(audio.currentTime) ? audio.currentTime : 0;
		var wasPlaying = !!(audio && !audio.paused);
		var index = run.index;
		run.controller.abort();
		run.controller = new AbortController();
		run.parts.forEach(releasePart);
		run.parts = run.parts.map(function (part) {
			return createPart(part.text, part.startWord);
		});
		run.failed = null;
		run.pendingSeek = { fromEnd: false, seconds: at };
		playPart(index, wasPlaying);
	}

	function applySpeed(next) {
		speed = clampSpeed(next);
		applyRate(audio);
		saveSpeed(speed);
		if (ui.speed) ui.speed.value = String(speed);
	}

	function applyHighlightStyle(next) {
		if (HIGHLIGHT_STYLES.indexOf(next) === -1) return;
		highlightStyle = next;
		saveHighlightStyle(highlightStyle);
		if (ui.highlight) ui.highlight.value = highlightStyle;
		clearSurfaceHighlight();
		paintHighlight(true);
	}

	// ------------------------------------------------------------------- UI

	var ui = {};

	var ICONS = {
		play: 'M6 4l12 8-12 8z',
		pause: 'M7 4h3.5v16H7zM13.5 4H17v16h-3.5z',
		stop: 'M6 6h12v12H6z',
		prev: 'M7 5h2.5v14H7zM19 5v14l-9-7z',
		next: 'M14.5 5H17v14h-2.5zM5 5l9 7-9 7z',
		rewind: 'M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z',
		forward: 'M12 5V2l5 4-5 4V7a5 5 0 1 0 5 5h2a7 7 0 1 1-7-7z'
	};

	function icon(path) {
		var ns = 'http://www.w3.org/2000/svg';
		var svg = document.createElementNS(ns, 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('width', '14');
		svg.setAttribute('height', '14');
		svg.setAttribute('aria-hidden', 'true');
		var p = document.createElementNS(ns, 'path');
		p.setAttribute('d', path);
		p.setAttribute('fill', 'currentColor');
		svg.appendChild(p);
		return svg;
	}

	function button(className, label, iconPath, onClick) {
		var b = el('button', className, { type: 'button', title: label, 'aria-label': label });
		b.appendChild(icon(iconPath));
		b.addEventListener('click', onClick);
		return b;
	}

	function buildBar() {
		var bar = el('div', 'ztts-bar', { role: 'group', 'aria-label': 'Read aloud controls' });

		// Always visible: the way in, and the reminder that this exists at all.
		ui.docBtn = el('button', 'ztts-doc-btn', {
			type: 'button',
			title: 'Read this document aloud; Command-click or Ctrl-click text to jump while reading',
			'aria-label': 'Read this document aloud'
		});
		ui.docBtn.appendChild(icon(ICONS.play));
		ui.docBtn.appendChild(document.createTextNode(' Read aloud'));
		ui.docBtn.addEventListener('click', function () {
			if (isDocumentRun(run)) stopRun();
			else readDocument();
		});
		bar.appendChild(ui.docBtn);

		// Everything below is the transport, revealed only while reading.
		ui.transport = el('div', 'ztts-transport');
		bar.appendChild(ui.transport);
		var group = ui.transport;

		group.appendChild(button('ztts-btn', 'Previous part', ICONS.prev, previousPart));
		group.appendChild(button('ztts-btn', 'Back ' + SEEK_STEP + ' seconds', ICONS.rewind, function () {
			seekBy(-SEEK_STEP);
		}));

		ui.play = button('ztts-btn ztts-primary', 'Play', ICONS.play, togglePlay);
		group.appendChild(ui.play);

		group.appendChild(button('ztts-btn', 'Forward ' + SEEK_STEP + ' seconds', ICONS.forward, function () {
			seekBy(SEEK_STEP);
		}));
		group.appendChild(button('ztts-btn', 'Next part', ICONS.next, nextPart));

		ui.scrub = el('input', 'ztts-scrub', {
			type: 'range', min: '0', max: '1', step: '0.1', value: '0',
			'aria-label': 'Position in this part'
		});
		ui.scrub.addEventListener('input', function () {
			if (audio && audio.src) {
				audio.currentTime = Number(ui.scrub.value);
				saveReadProgress(true);
			}
		});
		group.appendChild(ui.scrub);

		ui.clock = el('span', 'ztts-clock');
		ui.clock.textContent = '0:00 / 0:00';
		group.appendChild(ui.clock);

		ui.part = el('span', 'ztts-part');
		group.appendChild(ui.part);

		ui.voice = el('select', 'ztts-voice', { 'aria-label': 'Voice' });
		// Start with the current voice alone so the control is usable before
		// (or without) the voice list arriving.
		ui.voice.appendChild(
			(function () {
				var o = el('option');
				o.value = voice;
				o.textContent = voiceLabel(voice);
				return o;
			})()
		);
		ui.voice.value = voice;
		ui.voice.addEventListener('change', function () {
			applyVoice(ui.voice.value);
		});
		group.appendChild(ui.voice);
		populateVoices();

		ui.speed = el('select', 'ztts-speed', { 'aria-label': 'Reading speed' });
		SPEEDS.forEach(function (s) {
			var opt = el('option');
			opt.value = String(s);
			opt.textContent = s + '×';
			ui.speed.appendChild(opt);
		});
		// A stored speed that is not one of the presets still has to show:
		// add it rather than silently snapping the user to 1x.
		if (SPEEDS.indexOf(speed) === -1) {
			var custom = el('option');
			custom.value = String(speed);
			custom.textContent = speed + '×';
			ui.speed.appendChild(custom);
		}
		ui.speed.value = String(speed);
		ui.speed.addEventListener('change', function () {
			applySpeed(ui.speed.value);
		});
		group.appendChild(ui.speed);

		if (ALIGNMENT_ENDPOINT) {
			ui.highlight = el('select', 'ztts-highlight', { 'aria-label': 'Highlight style' });
			[
				['ball', 'Bouncing ball'],
				['sentence', 'Sentence'],
				['word', 'Word']
			].forEach(function (pair) {
				var opt = el('option');
				opt.value = pair[0];
				opt.textContent = pair[1];
				ui.highlight.appendChild(opt);
			});
			ui.highlight.value = highlightStyle;
			ui.highlight.addEventListener('change', function () {
				applyHighlightStyle(ui.highlight.value);
			});
			group.appendChild(ui.highlight);

			ui.surfaceFollow = el('button', 'ztts-btn ztts-surface-follow', { type: 'button' });
			ui.surfaceFollow.addEventListener('click', function () {
				if (!run) return;
				if (run.surfaceFollowing) suspendSurfaceFollow();
				else {
					run.surfaceFollowing = true;
					renderSurfaceFollow();
					paintHighlight(true, true);
				}
			});
			renderSurfaceFollow();
			group.appendChild(ui.surfaceFollow);

			ui.alignStatus = el('span', 'ztts-align-status');
			group.appendChild(ui.alignStatus);
		}

		group.appendChild(button('ztts-btn', 'Stop reading', ICONS.stop, stopRun));

		if (ALIGNMENT_ENDPOINT) {
			ui.follow = el('div', 'ztts-follow', { 'aria-label': 'Read-along text' });
			ui.followText = el('div', 'ztts-follow-text');
			ui.followText.addEventListener('scroll', function () {
				if (!run) return;
				var part = run.parts[run.index];
				placeBall(part, part ? part.activeWord : -1);
			}, { passive: true });
			ui.followBall = el('span', 'ztts-follow-ball', { 'aria-hidden': 'true' });
			ui.followText.appendChild(ui.followBall);
			ui.follow.appendChild(ui.followText);
			bar.appendChild(ui.follow);
		}

		// On the BAR, not in the transport group: an error raised before a run
		// exists collapses the transport (see setError), and an error message
		// inside the thing being hidden is no message at all.
		ui.error = el('span', 'ztts-error');
		bar.appendChild(ui.error);

		return bar;
	}

	/**
	 * Fill the voice control from Kokoro's own list, so it stays right when the
	 * server's voices change. Fetched once per page; on failure the control
	 * keeps the single configured voice and read-aloud still works.
	 */
	var voicesLoaded = false;
	function populateVoices() {
		if (voicesLoaded) return;
		voicesLoaded = true;
		// Wrapped: this runs while the bar is being built, and a fetch that
		// throws synchronously (an unusual polyfill, a blocked scheme) would
		// otherwise propagate out of buildBar and leave the reader with no
		// transport at all. A missing voice list must never cost more than the
		// voice list.
		try {
		fetch(ENDPOINT + '/v1/audio/voices', { credentials: 'same-origin' })
			.then(function (response) {
				if (!response.ok) throw new Error('HTTP ' + response.status);
				return response.json();
			})
			.then(function (body) {
				var raw = (body && (body.voices || body.data)) || [];
				var ids = raw.map(function (v) {
					return typeof v === 'string' ? v : (v && (v.id || v.name));
				}).filter(Boolean);
				if (!ids.length || !ui.voice) return;
				// Keep the active voice selectable even if the server stopped
				// offering it, so a stored choice cannot silently change.
				if (ids.indexOf(voice) === -1) ids.unshift(voice);

				var groups = {};
				var order = [];
				ids.forEach(function (id) {
					var g = voiceGroup(id);
					if (!groups[g]) { groups[g] = []; order.push(g); }
					groups[g].push(id);
				});
				order.sort(function (a, b) {
					// "Other" last; everything else alphabetical.
					if (a === 'Other') return 1;
					if (b === 'Other') return -1;
					return a.localeCompare(b);
				});

				ui.voice.innerHTML = '';
				order.forEach(function (g) {
					var grp = el('optgroup');
					grp.label = g;
					groups[g].sort().forEach(function (id) {
						var o = el('option');
						o.value = id;
						o.textContent = voiceLabel(id);
						grp.appendChild(o);
					});
					ui.voice.appendChild(grp);
				});
				ui.voice.value = voice;
			})
			.catch(function () {
				// Leave the single configured voice in place.
			});
		}
		catch (e) { /* same: the transport matters more than the list */ }
	}

	function setPhase(phase) {
		if (!ui.play) return;
		var playing = phase === 'playing';
		ui.play.innerHTML = '';
		if (phase === 'loading') {
			ui.play.textContent = '…';
		}
		else {
			ui.play.appendChild(icon(playing ? ICONS.pause : ICONS.play));
		}
		ui.play.setAttribute('title', playing ? 'Pause' : 'Play');
		ui.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
		ui.play.disabled = phase === 'loading';
		if (phase !== 'error') setError(null);
	}

	function setError(message) {
		if (!ui.error) return;
		ui.error.textContent = message || '';
		if (!message) return;
		if (ui.play) {
			ui.play.disabled = false;
			ui.play.innerHTML = '';
			ui.play.appendChild(icon(ICONS.play));
		}
		// An error before a run exists (no attachment, no indexed full text)
		// leaves nothing for the transport to control. Collapse back to the
		// entry button — still showing the message — so the way to try again
		// is visible instead of hidden behind Stop.
		if (!run && ui.bar) ui.bar.classList.remove('ztts-playing');
	}

	function renderMeta() {
		if (!ui.part || !run) return;
		ui.part.textContent = run.parts.length > 1
			? 'Part ' + (run.index + 1) + '/' + run.parts.length
			: '';
	}

	function renderAlignStatus() {
		if (!ui.alignStatus || !run || !ALIGNMENT_ENDPOINT) return;
		var part = run.parts[run.index];
		if (!part) {
			ui.alignStatus.textContent = '';
		}
		else if (part.timeline && part.timeline.length) {
			ui.alignStatus.textContent = 'Aligned';
		}
		else if (part.alignPending) {
			ui.alignStatus.textContent = 'Aligning…';
		}
		else if (part.alignmentError) {
			ui.alignStatus.textContent = 'Alignment unavailable';
			ui.alignStatus.title = part.alignmentError;
			return;
		}
		else {
			ui.alignStatus.textContent = 'Awaiting alignment';
		}
		ui.alignStatus.removeAttribute('title');
	}

	function renderFollow() {
		if (!ALIGNMENT_ENDPOINT || !ui.followText || !run) return;
		var part = run.parts[run.index];
		if (!part || ui.followPart === part) {
			renderAlignStatus();
			return;
		}
		var readAlong = readAlongTokens(part.text);
		part.readAlong = readAlong;
		part.activeWord = -1;
		ui.followPart = part;
		ui.followText.innerHTML = '';
		if (ui.followBall) {
			ui.followBall.hidden = true;
			ui.followBall.dataset.ready = 'false';
			ui.followText.appendChild(ui.followBall);
		}
		readAlong.pieces.forEach(function (piece) {
			if (piece.wordIndex === null) {
				ui.followText.appendChild(document.createTextNode(piece.text));
				return;
			}
			var wrap = el('span', 'ztts-read-word-wrap');
			var word = el('span', 'ztts-read-word', { 'data-word-index': String(piece.wordIndex) });
			word.textContent = piece.text;
			word.addEventListener('click', function () {
				if (run && run.parts[run.index] === part) seekToWord(run.index, piece.wordIndex);
			});
			wrap.appendChild(word);
			readAlong.wordEls[piece.wordIndex] = { wrap: wrap, word: word };
			ui.followText.appendChild(wrap);
		});
		renderAlignStatus();
		paintHighlight(true);
	}

	function placeBall(part, activeWord) {
		if (!ui.followBall) return;
		if (highlightStyle !== 'ball' || !part || activeWord < 0
			|| !part.readAlong || !part.readAlong.wordEls[activeWord]) {
			ui.followBall.hidden = true;
			ui.followBall.dataset.ready = 'false';
			return;
		}
		var target = part.readAlong.wordEls[activeWord].word;
		var host = ui.followText;
		var targetRect = target.getBoundingClientRect();
		var hostRect = host.getBoundingClientRect();
		var x = targetRect.left - hostRect.left + host.scrollLeft + targetRect.width / 2;
		var y = targetRect.top - hostRect.top + host.scrollTop;
		ui.followBall.style.transform = 'translate3d(' + x + 'px, ' + y + 'px, 0)';
		ui.followBall.hidden = false;
		if (ui.followBall.dataset.ready !== 'true') {
			requestAnimationFrame(function () {
				if (ui.followBall) ui.followBall.dataset.ready = 'true';
			});
		}
	}

	function normalizedMatchWord(word) {
		var s = String(word || '');
		try {
			s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
			return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
		}
		catch (e) {
			return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
		}
	}

	function partMatchWords(part) {
		if (!part) return [];
		if (!part.readAlong) part.readAlong = readAlongTokens(part.text);
		if (!part.surfaceWords) {
			part.surfaceWords = part.readAlong.words.map(normalizedMatchWord);
		}
		return part.surfaceWords;
	}

	function acceptsSurfaceTextNode(node, includeWhitespace) {
		if (!node || !node.nodeValue || (!includeWhitespace && !node.nodeValue.trim())) return false;
		var el = node.parentElement;
		if (!el) return false;
		if (el.closest([
			'script', 'style', 'noscript', 'template', 'svg',
			'header', 'footer', 'aside', '[role="doc-footnote"]', '[role="doc-endnote"]',
			'[role="doc-noteref"]', '[role="doc-pageheader"]', '[role="doc-pagefooter"]',
			'[epub\\:type~="footnote"]', '[epub\\:type~="endnote"]', '[epub\\:type~="noteref"]',
			'.ztts-bar', '.ztts-selection',
			'#toolbarContainer', '#toolbarViewer', '#secondaryToolbar',
			'#findbar', '#loadingBar', '#errorWrapper',
			'#reader-ui', '#secondary-view', '#sidebarContainer', '#sidebarContent',
			'.secondary-view', '.sidebar', '.sidebar-toolbar', '.toolbar',
			'.annotations', '.annotation', '.annotation-popup', '.preview',
			'.preview-popup', '.footnote-popup', '.editor', '.editor-toolbar',
			'[contenteditable="true"]', '[role="toolbar"]', '[role="button"]'
		].join(', '))) {
			return false;
		}
		var win = el.ownerDocument && el.ownerDocument.defaultView;
		if (!win || !win.getComputedStyle) return true;
		var style = win.getComputedStyle(el);
		return style && style.display !== 'none' && style.visibility !== 'hidden';
	}

	function surfaceRootForDoc(doc) {
		if (!doc) return null;
		return doc.querySelector('#viewer, .pdfViewer, #viewerContainer, #primary-view, .primary-view, article, main') || doc.body;
	}

	function rangeForToken(token) {
		return tokenRange(token.doc, token, token);
	}

	function usableSurfaceRectsForToken(token) {
		if (token.segments) return token.segments.flatMap(usableSurfaceRectsForToken);
		var range = rangeForToken(token);
		if (!range) return [];
		var rects = Array.prototype.slice.call(range.getClientRects()).filter(function (rect) {
			return rect.width > 1 && rect.height > 1;
		});
		var page = token.node.parentElement && token.node.parentElement.closest('.page');
		return rects.filter(function (rect) {
			if (!page) return true;
			var pageRect = page.getBoundingClientRect();
			if (pageRect.width < 300 || pageRect.height < 400) return true;
			var marginX = pageRect.width * 0.055;
			var marginY = pageRect.height * 0.04;
			return rect.left >= pageRect.left + marginX
				&& rect.right <= pageRect.right - marginX
				&& rect.top >= pageRect.top + marginY
				&& rect.bottom <= pageRect.bottom - marginY;
		});
	}

	function surfaceTokensForDoc(doc, root, includeUnmounted) {
		var tokens = [];
		root = root || surfaceRootForDoc(doc);
		if (!root) return tokens;
		var filter = doc.defaultView && doc.defaultView.NodeFilter;
		var walker = doc.createTreeWalker(
			root,
			filter ? filter.SHOW_TEXT : 4,
			{
				acceptNode: function (node) {
					return acceptsSurfaceTextNode(node)
						? (filter ? filter.FILTER_ACCEPT : 1)
						: (filter ? filter.FILTER_REJECT : 2);
				}
			}
		);
		var re = /\S+/g;
		var node;
		while ((node = walker.nextNode())) {
			var text = node.nodeValue || '';
			var match;
			re.lastIndex = 0;
			while ((match = re.exec(text))) {
				var norm = normalizedMatchWord(match[0]);
				// A PDF may put the line-ending hyphen in its own text node.
				// Retain it until wrapped words have been assembled below.
				if (!norm && !/^[-\u00AD\u2010]$/.test(match[0])) continue;
				tokens.push({
					doc: doc,
					node: node,
					start: match.index,
					end: match.index + match[0].length,
					text: match[0],
					norm: norm
				});
			}
		}
		if (includeUnmounted) return tokens.filter(function (token) { return token.norm; });
		tokens = tokens.filter(function (token) {
			return usableSurfaceRectsForToken(token).length > 0;
		});
		var pages = new Map();
		var plain = [];
		tokens.forEach(function (token) {
			var page = token.node.parentElement.closest('.page');
			if (!page) { plain.push(token); return; }
			var pageRect = page.getBoundingClientRect();
			var rect = usableSurfaceRectsForToken(token)[0];
			if (!pages.has(page)) pages.set(page, { width: pageRect.width, height: pageRect.height, fragments: [] });
			pages.get(page).fragments.push({
				text: token.text, left: rect.left - pageRect.left, right: rect.right - pageRect.left,
				y: rect.bottom - pageRect.top, size: rect.height, token: token
			});
		});
		var ordered = [];
		pages.forEach(function (page) {
			page.lines = pdfReadingOrder(page.fragments, 0, page.width);
			if (isPdfMetadataPage(page)) return;
			pdfBodyLines(page).forEach(function (line) {
				line.fragments.forEach(function (fragment) {
					fragment.token.speechLine = line;
					ordered.push(fragment.token);
				});
			});
		});
		var joined = [];
		ordered.forEach(function (token, index) {
			var previous = joined[joined.length - 1];
			var next = ordered[index + 1];
			var joinedText = null;
			if (previous && previous.speechLine === token.speechLine
				&& /[\p{L}\p{M}]$/u.test(previous.text) && /^[-\u00AD\u2010]$/.test(token.text)
				&& next && next.speechLine !== token.speechLine && /^\p{L}/u.test(next.text)) {
				joinedText = previous.text + token.text;
			}
			else if (previous && previous.speechLine !== token.speechLine
				&& /[\p{L}\p{M}][-\u00AD\u2010]$/u.test(previous.text) && /^\p{L}/u.test(token.text)) {
				joinedText = previous.text.slice(0, -1) + token.text;
			}
			if (joinedText !== null) {
				previous.segments = (previous.segments || [Object.assign({}, previous)]).concat(token);
				previous.text = joinedText;
				previous.norm = normalizedMatchWord(previous.text);
				previous.speechLine = token.speechLine;
			}
			else joined.push(token);
		});
		return joined.concat(plain).filter(function (token) { return token.norm; });
	}

	function scoreSurfaceCandidate(partWords, activeWord, tokens, tokenIndex) {
		var score = 0;
		var available = 0;
		for (var offset = -5; offset <= 7; offset++) {
			var p = activeWord + offset;
			var t = tokenIndex + offset;
			if (p < 0 || p >= partWords.length || !partWords[p]) continue;
			available += 1;
			if (t >= 0 && t < tokens.length && tokens[t].norm === partWords[p]) {
				score += offset === 0 ? 2 : 1;
			}
		}
		return { score: score, available: available };
	}

	function locateSurfaceWord(part, activeWord) {
		var partWords = partMatchWords(part);
		var wanted = partWords[activeWord];
		if (!wanted) return null;
		var epub = locateEpubWord(part, activeWord);
		if (epub) return epub;
		var pdfPage = pdfPageForWord(part, activeWord);
		function onPage(token) {
			var page = pdfPage && token.node.parentElement.closest('.page');
			return !pdfPage || (page && Number(page.dataset.pageNumber) === pdfPage);
		}

		if (part.surfaceLast) {
			var delta = activeWord - part.surfaceLast.activeWord;
			if (Math.abs(delta) <= 3) {
				var nextIndex = part.surfaceLast.tokenIndex + delta;
				var previousTokens = surfaceTokensForDoc(part.surfaceLast.doc);
				if (nextIndex >= 0 && nextIndex < previousTokens.length
					&& previousTokens[nextIndex].norm === wanted && onPage(previousTokens[nextIndex])) {
					var nearby = scoreSurfaceCandidate(partWords, activeWord, previousTokens, nextIndex);
					if (nearby.score >= Math.min(4, nearby.available + 1)) {
						return {
							doc: part.surfaceLast.doc,
							tokens: previousTokens,
							tokenIndex: nextIndex,
							activeWord: activeWord
						};
					}
				}
			}
		}

		var best = null;
		readerDocuments().forEach(function (doc) {
			var tokens = surfaceTokensForDoc(doc);
			for (var i = 0; i < tokens.length; i++) {
				if (tokens[i].norm !== wanted || !onPage(tokens[i])) continue;
				var scored = scoreSurfaceCandidate(partWords, activeWord, tokens, i);
				var threshold = scored.available <= 2 && wanted.length >= 5 ? 2 : 4;
				if (scored.score < Math.min(threshold, scored.available + 1)) continue;
				if (!best || scored.score > best.score) {
					best = {
						doc: doc,
						tokens: tokens,
						tokenIndex: i,
						activeWord: activeWord,
						score: scored.score
					};
				}
			}
		});
		if (best) part.surfaceLast = best;
		return best;
	}

	function tokenAtPoint(doc, clientX, clientY) {
		var tokens = surfaceTokensForDoc(doc);
		for (var i = 0; i < tokens.length; i++) {
			var rects = usableSurfaceRectsForToken(tokens[i]);
			for (var r = 0; r < rects.length; r++) {
				var rect = rects[r];
				if (clientX >= rect.left && clientX <= rect.right
					&& clientY >= rect.top && clientY <= rect.bottom) {
					return { tokens: tokens, tokenIndex: i, token: tokens[i] };
				}
			}
		}
		return null;
	}

	function wordIndexForSurfaceToken(partWords, tokens, tokenIndex) {
		var token = tokens[tokenIndex];
		var wanted = token && token.norm;
		if (!wanted || !partWords.length) return -1;
		var best = null;
		for (var i = 0; i < partWords.length; i++) {
			if (partWords[i] !== wanted) continue;
			var scored = scoreSurfaceCandidate(partWords, i, tokens, tokenIndex);
			var threshold = scored.available <= 2 && wanted.length >= 5 ? 2 : 4;
			if (scored.score < Math.min(threshold, scored.available + 1)) continue;
			if (!best || scored.score > best.score) best = { index: i, score: scored.score };
		}
		return best ? best.index : -1;
	}

	function runPositionForSurfaceToken(tokens, tokenIndex, theRun) {
		theRun = theRun || run;
		if (!theRun.surfaceWordIndex) {
			var words = [];
			var positions = [];
			theRun.parts.forEach(function (part, partIndex) {
				partMatchWords(part).forEach(function (word, wordIndex) {
					words.push(word);
					positions.push({ partIndex: partIndex, wordIndex: wordIndex });
				});
			});
			theRun.surfaceWordIndex = { words: words, positions: positions };
		}
		// Match context across part boundaries too, so common words near a
		// boundary do not accidentally jump to a different occurrence.
		var index = wordIndexForSurfaceToken(theRun.surfaceWordIndex.words, tokens, tokenIndex);
		return index < 0 ? null : theRun.surfaceWordIndex.positions[index];
	}

	function seekToWord(partIndex, wordIndex) {
		if (!run) return false;
		var part = run.parts[partIndex];
		if (!part || wordIndex < 0 || wordIndex >= partMatchWords(part).length) return false;
		var at = part.url ? timeForWord(part, wordIndex) : null;
		if (at === null && part.url && wordIndex === part.startWord) at = 0;
		if (partIndex === run.index && !run.loading && audio && audio.src === part.url && at !== null) {
			run.pendingSeek = null;
			audio.currentTime = Math.max(0, at - 0.08);
			saveReadProgress(true);
			paintHighlight(true);
			return true;
		}
		var autoplay = run.loading ? run.autoplay : !!(audio && !audio.paused);
		saveReadProgress(true);
		if (at === null) {
			// A new part object also invalidates synthesis/alignment already
			// in flight for this part. Late results cannot replace this jump.
			run.parts[partIndex] = createPart(part.text, wordIndex);
			at = 0;
		}
		run.pendingSeek = { fromEnd: false, seconds: Math.max(0, at - 0.08) };
		playPart(partIndex, autoplay);
		if (run.parts[partIndex] !== part) releasePart(part);
		return true;
	}

	function seekToSurfacePoint(doc, clientX, clientY, event) {
		if (!run) return false;
		var hit = tokenAtPoint(doc, clientX, clientY);
		if (!hit) return false;
		var position = runPositionForSurfaceToken(hit.tokens, hit.tokenIndex);
		if (!position && run.source !== 'selection') return false;
		if (event) {
			event.preventDefault();
			event.stopPropagation();
		}
		if (!position) {
			readDocumentFromSurfaceHit(hit);
			return true;
		}
		// A newer click inside the run supersedes any full-document lookup.
		documentReadRequest++;
		seekToWord(position.partIndex, position.wordIndex);
		run.parts[position.partIndex].surfaceLast = {
			doc: doc,
			tokens: hit.tokens,
			tokenIndex: hit.tokenIndex,
			activeWord: position.wordIndex
		};
		return true;
	}

	function seekToSurfaceClick(doc, event) {
		if (!(event.metaKey || event.ctrlKey)) return false;
		if (event.button !== undefined && event.button !== 0) return false;
		return seekToSurfacePoint(doc, event.clientX, event.clientY, event);
	}

	function selectionTextForDoc(doc) {
		var selection = doc && doc.getSelection && doc.getSelection();
		return selection ? String(selection || '').trim() : '';
	}

	function rememberSurfaceTap(doc, clientX, clientY, target, pointerId) {
		doc.__zttsTapStart = {
			x: clientX,
			y: clientY,
			target: target || null,
			pointerId: pointerId === undefined ? null : pointerId,
			at: Date.now()
		};
	}

	function finishSurfaceTap(doc, clientX, clientY, target, pointerId, event) {
		var start = doc.__zttsTapStart;
		doc.__zttsTapStart = null;
		if (!start) return false;
		if (start.pointerId !== null && pointerId !== start.pointerId) return false;
		var dx = clientX - start.x;
		var dy = clientY - start.y;
		if (Math.sqrt(dx * dx + dy * dy) > 14) return false;
		if (Date.now() - start.at > 750) return false;
		if (selectionTextForDoc(doc)) return false;
		if (start.target && target && start.target !== target
			&& !(start.target.contains && start.target.contains(target))
			&& !(target.contains && target.contains(start.target))) {
			return false;
		}
		return seekToSurfacePoint(doc, clientX, clientY, event);
	}

	function tokenRange(doc, first, last) {
		if (!first || !last) return null;
		try {
			var range = doc.createRange();
			range.setStart(first.node, first.start);
			range.setEnd(last.node, last.end);
			return range;
		}
		catch (e) {
			return null;
		}
	}

	function rectsForRange(range, doc) {
		if (!range) return [];
		var win = doc.defaultView || window;
		return Array.prototype.slice.call(range.getClientRects()).map(function (rect) {
			return {
				left: rect.left,
				top: rect.top,
				width: rect.width,
				height: rect.height
			};
		}).filter(function (rect) {
			return rect.width > 1 && rect.height > 1
				&& rect.left < win.innerWidth
				&& rect.top < win.innerHeight
				&& rect.left + rect.width > 0
				&& rect.top + rect.height > 0;
		});
	}

	function sentenceSurfaceRects(part, target, sentence) {
		if (!sentence) return [];
		var partWords = partMatchWords(part);
		var firstPart = sentence.start;
		var lastPart = sentence.end;
		var firstToken = target.tokenIndex + (firstPart - target.activeWord);
		var lastToken = target.tokenIndex + (lastPart - target.activeWord);
		if (firstToken < 0 || lastToken >= target.tokens.length) return [];
		for (var p = firstPart; p <= lastPart; p++) {
			var token = target.tokens[target.tokenIndex + (p - target.activeWord)];
			if (!token || token.norm !== partWords[p]) return [];
		}
		return target.tokens.slice(firstToken, lastToken + 1).flatMap(surfaceTokenRects);
	}

	function surfaceTokenRects(token) {
		return (token.segments || [token]).flatMap(function (segment) {
			return rectsForRange(rangeForToken(segment), segment.doc);
		});
	}

	function ensureSurfaceStyle(doc) {
		if (!doc || doc.getElementById(SURFACE_STYLE_ID)) return;
		var style = doc.createElement('style');
		style.id = SURFACE_STYLE_ID;
		style.textContent = SURFACE_STYLE_TEXT;
		(doc.head || doc.documentElement).appendChild(style);
	}

	function surfaceLayer(doc) {
		if (!doc || !doc.body) return null;
		ensureSurfaceStyle(doc);
		var layer = doc.__zttsSurfaceLayer;
		if (!layer) {
			layer = doc.createElement('div');
			layer.className = 'ztts-surface-layer';
			layer.setAttribute('aria-hidden', 'true');
			doc.__zttsSurfaceLayer = layer;
		}
		if (layer.parentNode !== doc.body) {
			doc.body.appendChild(layer);
		}
		ui.surfaceLayer = layer;
		ui.surfaceDoc = doc;
		return layer;
	}

	function clearSurfaceHighlight() {
		surfacePaint = null;
		if (ui.surfaceLayer) ui.surfaceLayer.innerHTML = '';
		readerDocuments().forEach(function (doc) {
			var layer = doc && (doc.__zttsSurfaceLayer || doc.querySelector('.ztts-surface-layer'));
			if (layer) layer.innerHTML = '';
		});
		if (ui.bar) ui.bar.classList.remove('ztts-surface-active');
	}

	function drawSurfaceRects(doc, rects, className) {
		var layer = surfaceLayer(doc);
		if (!layer) return;
		rects.forEach(function (rect) {
			var mark = doc.createElement('span');
			mark.className = 'ztts-surface-mark ' + className;
			mark.style.left = rect.left + 'px';
			mark.style.top = rect.top + 'px';
			mark.style.width = rect.width + 'px';
			mark.style.height = rect.height + 'px';
			layer.appendChild(mark);
		});
	}

	function drawSurfaceBall(doc, rects) {
		if (!rects.length) return;
		var layer = surfaceLayer(doc);
		if (!layer) return;
		var first = rects[0];
		var ball = doc.createElement('span');
		ball.className = 'ztts-surface-ball';
		ball.style.transform = 'translate3d('
			+ (first.left + first.width / 2) + 'px, '
			+ first.top + 'px, 0)';
		layer.appendChild(ball);
	}

	function renderSurfaceFollow() {
		if (!ui.surfaceFollow) return;
		var following = !!(run && run.surfaceFollowing);
		ui.surfaceFollow.textContent = following ? 'Following reading' : 'Follow reading';
		ui.surfaceFollow.setAttribute('aria-pressed', String(following));
		ui.surfaceFollow.title = following ? 'Pause automatic page turns' : 'Return to the spoken text and follow along';
	}

	function cancelSurfaceScroll() {
		if (!run || !run.surfaceScroll) return;
		var motion = run.surfaceScroll;
		run.surfaceScroll = null;
		motion.element.scrollTo({ left: motion.element.scrollLeft, top: motion.element.scrollTop, behavior: 'instant' });
	}

	function suspendSurfaceFollow() {
		if (!run || !run.surfaceFollowing) return;
		run.surfaceFollowing = false;
		run.surfacePdfReveal = null;
		cancelSurfaceScroll();
		renderSurfaceFollow();
	}

	function surfaceScrollElement(token) {
		var doc = token.doc;
		var win = doc.defaultView;
		for (var el = token.node.parentElement; el && el !== doc.body; el = el.parentElement) {
			var style = win.getComputedStyle(el);
			if ((el.scrollHeight > el.clientHeight && /auto|scroll|hidden/.test(style.overflowY))
				|| (el.scrollWidth > el.clientWidth && /auto|scroll|hidden/.test(style.overflowX))) return el;
		}
		return doc.scrollingElement;
	}

	function surfaceViewport(doc, element) {
		var win = doc.defaultView;
		if (element === doc.scrollingElement) {
			return { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight };
		}
		var rect = element.getBoundingClientRect();
		var left = rect.left + element.clientLeft;
		var top = rect.top + element.clientTop;
		return { left: Math.max(0, left), top: Math.max(0, top),
			right: Math.min(win.innerWidth, left + element.clientWidth),
			bottom: Math.min(win.innerHeight, top + element.clientHeight) };
	}

	function scrollSurfaceTo(doc, element, left, top, navigate) {
		var theRun = run;
		var motion = { doc: doc, element: element };
		theRun.surfaceScroll = motion;
		var win = doc.defaultView;
		var reduced = win.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (navigate) navigate();
		else element.scrollTo({ left: left, top: top, behavior: reduced ? 'instant' : 'smooth' });
		// Repaints during a page turn must never start another scroll. Watch
		// for settling instead of assuming every scroll event is user input.
		var lastLeft = element.scrollLeft, lastTop = element.scrollTop;
		var started = Date.now(), lastMoved = started;
		function settled() {
			if (run !== theRun || run.surfaceScroll !== motion) return;
			if (element.scrollLeft !== lastLeft || element.scrollTop !== lastTop) lastMoved = Date.now();
			lastLeft = element.scrollLeft;
			lastTop = element.scrollTop;
			if (Date.now() - lastMoved >= 160 || Date.now() - started > 2000) {
				run.surfaceScroll = null;
				paintHighlight(true, !!motion.pending);
				return;
			}
			window.requestAnimationFrame(settled);
		}
		window.requestAnimationFrame(settled);
	}

	function followSurfaceWord(target) {
		if (!run || !run.surfaceFollowing) return;
		if (run.surfaceScroll) {
			run.surfaceScroll.pending = true;
			return;
		}
		var token = target.tokens[target.tokenIndex];
		var view = target.doc.defaultView.frameElement;
		view = view && view.ownerDocument.defaultView._reader;
		view = view && view._primaryView;
		var paginated = view && view._iframeDocument === target.doc && view.flowMode === 'paginated';
		if (paginated && !token.node.isConnected) {
			scrollSurfaceTo(target.doc, target.doc.querySelector('.sections'), 0, 0, function () {
				view.flow.scrollIntoView(rangeForToken(token), { skipHistory: true });
			});
			return;
		}
		var element = surfaceScrollElement(token);
		if (!element) return;
		// Use the word's range, not its paragraph (which can span a whole
		// screen), and keep offscreen rectangles for navigation.
		var rects = usableSurfaceRectsForToken(token);
		var viewport = surfaceViewport(target.doc, element);
		var margin = paginated ? 0 : Math.min(24, (viewport.bottom - viewport.top) / 10);
		if (rects.some(function (rect) {
			return rect.left >= viewport.left && rect.right <= viewport.right
				&& rect.top >= viewport.top + margin && rect.bottom <= viewport.bottom - margin;
		})) return;
		var rect = rects[0];
		if (!rect) return;
		if (paginated) {
			scrollSurfaceTo(target.doc, element, 0, 0, function () {
				view.flow.scrollIntoView(rangeForToken(token), { skipHistory: true });
			});
			return;
		}
		var top = element.scrollTop;
		var left = element.scrollLeft;
		if (rect.top < viewport.top + margin || rect.bottom > viewport.bottom - margin) {
			top += rect.top - viewport.top - Math.max(margin, (viewport.bottom - viewport.top) * 0.15);
		}
		if (rect.left < viewport.left) left += rect.left - viewport.left - margin;
		else if (rect.right > viewport.right) left += rect.right - viewport.right + margin;
		top = Math.max(0, Math.min(top, element.scrollHeight - element.clientHeight));
		left = Math.max(0, Math.min(left, element.scrollWidth - element.clientWidth));
		if (Math.abs(top - element.scrollTop) > 1 || Math.abs(left - element.scrollLeft) > 1) {
			scrollSurfaceTo(target.doc, element, left, top);
		}
	}

	function watchSurfaceNavigation(doc) {
		function inControl(target) {
			return target && target.closest && target.closest(
				'input, textarea, select, [contenteditable="true"], .ztts-bar, #sidebarContainer, .sidebar');
		}
		doc.addEventListener('wheel', function (event) {
			if (!event.ctrlKey && !inControl(event.target) && (event.deltaX || event.deltaY)) suspendSurfaceFollow();
		}, { capture: true, passive: true });
		doc.addEventListener('touchmove', function (event) {
			if (!inControl(event.target)) suspendSurfaceFollow();
		}, { capture: true, passive: true });
		doc.addEventListener('keydown', function (event) {
			if (!inControl(event.target) && !event.metaKey && !event.ctrlKey && !event.altKey
				&& ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].indexOf(event.key) !== -1) {
				suspendSurfaceFollow();
			}
		}, true);
		doc.addEventListener('pointerdown', function (event) {
			if (!inControl(event.target) && run && run.surfaceScroll) suspendSurfaceFollow();
		}, true);
	}

	function matchIndexedSurfaceWord(part, active, tokens) {
		var words = partMatchWords(part);
		var expected = active;
		for (var p = 0; p < run.index; p++) expected += partMatchWords(run.parts[p]).length;
		var best = null;
		tokens.forEach(function (token, index) {
			if (token.norm !== words[active]) return;
			var scored = scoreSurfaceCandidate(words, active, tokens, index);
			if (scored.score < Math.min(4, scored.available + 1)) return;
			var distance = Math.abs(index - expected);
			if (!best || scored.score > best.score
				|| (scored.score === best.score && run.source === 'document' && distance < best.distance)) {
				best = { index: index, score: scored.score, distance: distance };
			}
		});
		return best ? best.index : -1;
	}

	function locateEpubWord(part, active) {
		if (!run || run.source !== 'document') return null;
		var docs = readerDocuments();
		for (var d = 0; d < docs.length; d++) {
			var reader = docs[d].defaultView && docs[d].defaultView._reader;
			if (!reader || reader._type !== 'epub') continue;
			var view = reader._primaryView;
			if (!view || !view.renderers || !view._iframeDocument) continue;
			// Paginated EPUBs unmount every other chapter. Keep text anchors
			// into those chapters so following can mount the correct one.
			var tokens = epubSurfaceCache.get(view);
			if (!tokens) {
				tokens = view.renderers.flatMap(function (renderer) {
					return surfaceTokensForDoc(view._iframeDocument, renderer.container, true);
				});
				if (!tokens.length) continue;
				epubSurfaceCache.set(view, tokens);
			}
			var index = matchIndexedSurfaceWord(part, active, tokens);
			if (index >= 0) return { doc: view._iframeDocument, tokens: tokens, tokenIndex: index, activeWord: active };
		}
		return null;
	}

	function pdfPageForWord(part, active) {
		if (!run || run.source !== 'document') return null;
		if (part.surfacePdfWord === active) return part.surfacePdfPage;
		var app = readerPdfApplication();
		var tokens = app && pdfSurfaceCache.get(app.pdfDocument);
		if (!tokens) return null;
		var index = matchIndexedSurfaceWord(part, active, tokens);
		part.surfacePdfWord = active;
		part.surfacePdfPage = index >= 0 ? tokens[index].page : null;
		return part.surfacePdfPage;
	}

	function followUnrenderedPdfWord(part, active) {
		if (!run || !run.surfaceFollowing) return;
		if (run.surfaceScroll) {
			run.surfaceScroll.pending = true;
			return;
		}
		var page = pdfPageForWord(part, active);
		var app = page && readerPdfApplication();
		if (!app || !app.pdfViewer) return;
		run.surfacePdfReveal = { app: app, page: page, part: part, active: active };
		if (!app.__zttsFollowWatched) {
			app.__zttsFollowWatched = true;
			app.eventBus.on('textlayerrendered', function (event) {
				if (!run || !run.surfaceFollowing) return;
				var reveal = run.surfacePdfReveal;
				if (!reveal || reveal.app !== app || reveal.page !== event.pageNumber) return;
				run.surfacePdfReveal = null;
				var current = run.parts[run.index];
				var requested = current === reveal.part && audio
					&& activeWordForPart(current, audio.currentTime) === reveal.active;
				paintHighlight(true, !!(requested || (audio && !audio.paused)));
			});
		}
		if (app.pdfViewer.currentPageNumber === page) return;
		var container = app.pdfViewer.container;
		scrollSurfaceTo(container.ownerDocument, container, 0, 0, function () {
			app.pdfViewer.scrollPageIntoView({ pageNumber: page });
		});
	}

	function paintSurfaceHighlight(part, active, sentence, follow) {
		if (!part || active < 0) {
			clearSurfaceHighlight();
			return false;
		}
		var target = locateSurfaceWord(part, active);
		if (!target) {
			if (follow) followUnrenderedPdfWord(part, active);
			clearSurfaceHighlight();
			return false;
		}
		if (follow) followSurfaceWord(target);
		var wordRects = surfaceTokenRects(target.tokens[target.tokenIndex]);
		if (!wordRects.length) {
			clearSurfaceHighlight();
			return false;
		}
		var paintKey = highlightStyle + ':' + run.index + ':' + active + ':'
			+ (target.doc.location ? target.doc.location.href : '') + ':'
			+ wordRects.map(function (r) {
				return Math.round(r.left) + ',' + Math.round(r.top) + ','
					+ Math.round(r.width) + ',' + Math.round(r.height);
			}).join('|');
		if (paintKey === surfacePaint) return true;
		surfacePaint = paintKey;
		if (ui.surfaceDoc && ui.surfaceDoc !== target.doc && ui.surfaceLayer) {
			ui.surfaceLayer.innerHTML = '';
		}
		var layer = surfaceLayer(target.doc);
		if (!layer) return false;
		layer.innerHTML = '';
		if (highlightStyle === 'sentence') {
			var sentenceRects = sentenceSurfaceRects(part, target, sentence);
			drawSurfaceRects(target.doc, sentenceRects.length ? sentenceRects : wordRects, 'sentence-spoken');
		}
		else {
			drawSurfaceRects(target.doc, wordRects, highlightStyle === 'word' ? 'word-spoken' : 'ball-active');
			if (highlightStyle === 'ball') drawSurfaceBall(target.doc, wordRects);
		}
		if (ui.bar) ui.bar.classList.add('ztts-surface-active');
		return true;
	}

	function paintHighlight(force, follow) {
		if (!ALIGNMENT_ENDPOINT || !run || !ui.followText) return;
		var part = run.parts[run.index];
		if (!part) return;
		if (!audio || audio.src !== part.url) return;
		if (!part.readAlong || ui.followPart !== part) renderFollow();
		if (!part.readAlong) return;
		var active = activeWordForPart(part, audio ? audio.currentTime : 0);
		if (!force && active === part.activeWord) return;
		var wordChanged = active !== part.activeWord;
		part.activeWord = active;
		var sentence = sentenceRangeForWord(part.readAlong.words, active);
		part.readAlong.wordEls.forEach(function (item, index) {
			if (!item) return;
			var isActive = index === active;
			var inSentence = !!(sentence && index >= sentence.start && index <= sentence.end);
			item.word.classList.toggle('spoken', highlightStyle === 'word' && isActive);
			item.word.classList.toggle('ball-active', highlightStyle === 'ball' && isActive);
			item.wrap.classList.toggle('sentence-spoken', highlightStyle === 'sentence' && inSentence);
		});
		placeBall(part, active);
		paintSurfaceHighlight(part, active, sentence,
			follow === true || (follow !== false && wordChanged && !audio.paused));
	}

	function syncScrubRange() {
		if (!ui.scrub || !audio) return;
		var duration = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 1;
		ui.scrub.max = String(duration);
		paintProgress();
	}

	function paintProgress() {
		if (!audio || !ui.scrub) return;
		var duration = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
		if (document.activeElement !== ui.scrub) {
			ui.scrub.value = String(audio.currentTime);
		}
		if (ui.clock) {
			ui.clock.textContent = formatClock(audio.currentTime) + ' / ' + formatClock(duration);
		}
		saveReadProgress(false);
		paintHighlight(false);
	}

	/**
	 * Put the bar in the reader, if it is not there already.
	 *
	 * It goes in as an ordinary flex child rather than an overlay:
	 * .reader-wrapper is already `display: flex; flex-direction: column` with
	 * `> iframe { flex: 1 1 100% }`, so a `flex: 0 0 auto` row at the end
	 * simply shortens the iframe. An absolutely positioned bar would have
	 * needed `position: relative` on .reader-wrapper, which would also have
	 * re-anchored upstream's `.portal` (the tag picker) — a side effect well
	 * outside what read-aloud has any business changing.
	 */
	function ensureBar() {
		var wrapper = document.querySelector('.reader-wrapper');
		if (!wrapper) return null;
		if (!ui.bar) ui.bar = buildBar();
		if (ui.bar.parentNode !== wrapper) wrapper.appendChild(ui.bar);
		return ui.bar;
	}

	function showBar() {
		var bar = ensureBar();
		if (!bar) return;
		bar.classList.add('ztts-playing');
		renderMeta();
		renderFollow();
		paintProgress();
	}

	function hideBar() {
		if (ui.bar) ui.bar.classList.remove('ztts-playing');
		if (ui.alignStatus) {
			ui.alignStatus.textContent = '';
			ui.alignStatus.removeAttribute('title');
		}
		if (ui.followBall) {
			ui.followBall.hidden = true;
			ui.followBall.dataset.ready = 'false';
		}
		setError(null);
	}

	// ------------------------------------------------------- text discovery

	/**
	 * The attachment key for the open reader, read off the URL.
	 *
	 * Mirrors web-library's own rule (src/js/component/reader.jsx): the
	 * `/attachment/<key>` segment wins when present, otherwise the item being
	 * viewed IS the attachment.
	 */
	function attachmentKey() {
		var path = location.pathname;
		var m = /\/attachment\/([a-zA-Z0-9]{8})(?:\/|$)/.exec(path);
		if (m) return m[1];
		m = /\/items\/([a-zA-Z0-9]{8})(?:\/|$)/.exec(path);
		return m ? m[1] : null;
	}

	// PDF.js exposes all pages, including ones the viewer has not rendered.
	// Keep layout until after filtering: the full-text index cannot tell a
	// footnote or a rotated margin notice from the paragraph beside it.
	function readerPdfApplication() {
		var docs = readerDocuments();
		var loadingPdf = false;
		for (var i = 0; i < docs.length; i++) {
			var win = docs[i].defaultView;
			if (win && win.PDFViewerApplication) return win.PDFViewerApplication;
			if (win && win._reader && win._reader._type === 'pdf') loadingPdf = true;
		}
		return loadingPdf ? {} : null;
	}

	function excludedPdfContentIds(tree) {
		var ids = new Set();
		function visit(node, excluded) {
			if (!node) return;
			excluded = excluded || /^(?:Artifact|Note|FENote|Footnote|Endnote)$/i.test(node.role || '');
			if (excluded && node.id) ids.add(node.id);
			(node.children || []).forEach(function (child) { visit(child, excluded); });
		}
		visit(tree, false);
		return ids;
	}

	function pdfPageLines(content, viewport, tree) {
		var excludedIds = excludedPdfContentIds(tree);
		var stack = [];
		var fragments = [];
		var v = viewport.transform;
		(content.items || []).forEach(function (item) {
			if (item.type === 'endMarkedContent') { stack.pop(); return; }
			if (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps') {
				stack.push(!!stack[stack.length - 1] || item.tag === 'Artifact' || excludedIds.has(item.id));
				return;
			}
			if (stack[stack.length - 1] || typeof item.str !== 'string' || !item.transform) return;
			var t = item.transform;
			var dx = v[0] * t[0] + v[2] * t[1];
			var dy = v[1] * t[0] + v[3] * t[1];
			var size = Math.hypot(v[0] * t[2] + v[2] * t[3], v[1] * t[2] + v[3] * t[3]);
			var style = content.styles && content.styles[item.fontName];
			// Rotated text along a page edge is usually a publisher notice.
			// Preserve vertical writing systems; rotation of the PDF page itself
			// has already been accounted for by the viewport transform.
			if (Math.abs(dy) > Math.abs(dx) * 0.3 && !(style && style.vertical)) return;
			if (!size) return;
			var x = v[0] * t[4] + v[2] * t[5] + v[4];
			var y = v[1] * t[4] + v[3] * t[5] + v[5];
			var width = Math.abs(item.width || 0) * Math.hypot(v[0], v[1]);
			if (dx < 0) x -= width;
			if (!item.str.trim()) return;
			fragments.push({ text: item.str, left: x, right: x + width, y: y, size: size });
		});
		return { lines: pdfReadingOrder(fragments, 0, viewport.width), width: viewport.width, height: viewport.height };
	}

	function pdfTextRows(fragments) {
		var rows = [];
		fragments.slice().sort(function (a, b) { return a.y - b.y || a.left - b.left; }).forEach(function (fragment) {
			var row = rows[rows.length - 1];
			// OCR often gives adjacent words different baselines and sizes.
			// Compare with the row's first baseline to avoid chaining two rows.
			if (!row || fragment.y - row.y > Math.max(row.size, fragment.size) * 0.55) {
				row = { y: fragment.y, size: fragment.size, fragments: [] };
				rows.push(row);
			}
			row.fragments.push(fragment);
			row.size = Math.max(row.size, fragment.size);
		});
		rows.forEach(function (row) { row.fragments.sort(function (a, b) { return a.left - b.left; }); });
		return rows;
	}

	function pdfColumnGutter(rows, left, right) {
		var width = right - left;
		var gaps = [];
		rows.forEach(function (row) {
			var items = row.fragments;
			for (var i = 1; i < items.length; i++) {
				var start = Math.max(items[i - 1].right, left + width * 0.22);
				var end = Math.min(items[i].left, right - width * 0.22);
				if (end - start < width * 0.025) continue;
				if (start - items[0].left < width * 0.16
					|| items[items.length - 1].right - end < width * 0.16) continue;
				gaps.push({ start: start, end: end });
			}
		});
		var best = null;
		gaps.forEach(function (gap) {
			var x = (gap.start + gap.end) / 2;
			var support = gaps.filter(function (other) { return other.start < x && other.end > x; });
			if (!best || support.length > best.count) {
				best = { x: x, count: support.length };
			}
		});
		return best && best.count >= Math.max(3, rows.length * 0.2) ? best.x : null;
	}

	function pdfSeparatedColumnGutter(rows, left, right) {
		var width = right - left;
		var best = null;
		// Sidebars and chapter outlines can end just as the main article starts.
		// In that layout few (or no) baselines contain text on both sides, so the
		// ordinary row-gap detector has no evidence. Sample the middle of the page
		// for a genuinely empty vertical channel instead. Requiring several rows
		// on either side and a channel wider than ordinary word spacing prevents a
		// ragged single column from being split in two.
		for (var step = 22; step <= 78; step++) {
			var x = left + width * step / 100;
			var before = 0;
			var after = 0;
			var crossing = 0;
			var nearestLeft = left;
			var nearestRight = right;
			rows.forEach(function (row) {
				var hasBefore = false;
				var hasAfter = false;
				var hasCrossing = false;
				row.fragments.forEach(function (item) {
					if (item.right <= x) {
						hasBefore = true;
						nearestLeft = Math.max(nearestLeft, item.right);
					}
					else if (item.left >= x) {
						hasAfter = true;
						nearestRight = Math.min(nearestRight, item.left);
					}
					else hasCrossing = true;
				});
				if (hasBefore) before++;
				if (hasAfter) after++;
				if (hasCrossing) crossing++;
			});
			var gap = nearestRight - nearestLeft;
			if (before < 3 || after < 3 || gap < width * 0.025
				|| crossing > Math.max(2, Math.min(before, after) * 0.25)) continue;
			var score = gap - crossing * width * 0.02;
			if (!best || score > best.score) {
				best = { x: (nearestLeft + nearestRight) / 2, score: score };
			}
		}
		return best ? best.x : null;
	}

	function pdfMergeRow(row) {
		var items = row.fragments;
		var text = '';
		var previous = null;
		items.forEach(function (item) {
			if (previous && item.left - previous.right > Math.min(item.size, previous.size) * 0.12
				&& !/\s$/.test(text) && !/^\s/.test(item.text)) text += ' ';
			text += item.text;
			previous = item;
		});
		return {
			text: text, left: items[0].left,
			right: Math.max.apply(null, items.map(function (item) { return item.right; })),
			y: row.y, size: Math.max.apply(null, items.map(function (item) { return item.size; })), fragments: items
		};
	}

	function pdfReadingOrder(fragments, left, right) {
		if (!fragments.length) return [];
		var originalRows = pdfTextRows(fragments);
		fragments = fragments.map(function (fragment) {
			// A scanned drop cap may have its OCR box on the third printed
			// line. Place it at the start of the indented paragraph it belongs to.
			if (!/^[A-Z]$/.test(fragment.text.trim())) return fragment;
			var following = originalRows.find(function (row) {
				var first = row.fragments.find(function (other) { return other.left >= fragment.left - fragment.size * 2; });
				return first && row.y < fragment.y - fragment.size && row.y > fragment.y - fragment.size * 4
					&& first.left > fragment.right + fragment.size * 0.5 && first.left < fragment.left + fragment.size * 4
					&& /^\p{Ll}/u.test(first.text);
			});
			if (!following || fragments.some(function (other) {
				return other.y < following.y - fragment.size * 0.6 && other.y > following.y - fragment.size * 3
					&& other.left >= fragment.left && other.left < fragment.left + (right - left) * 0.3;
			})) return fragment;
			return Object.assign({}, fragment, { y: following.y, sourceFragment: fragment });
		});
		var rows = pdfTextRows(fragments);
		var gutter = pdfColumnGutter(rows, left, right);
		if (gutter === null) gutter = pdfSeparatedColumnGutter(rows, left, right);
		if (gutter === null) {
			if (rows.length >= 3) return rows.map(pdfMergeRow);
			// Sparse rows cannot establish recurring columns. Keep widely
			// separated labels/notes separate instead of joining across the page.
			var sparse = [];
			rows.forEach(function (row) {
				var part = { y: row.y, size: row.size, fragments: [] };
				row.fragments.forEach(function (item) {
					var previous = part.fragments[part.fragments.length - 1];
					if (previous && item.left - previous.right > Math.min(item.size, previous.size) * 2.3) {
						sparse.push(pdfMergeRow(part));
						part = { y: row.y, size: item.size, fragments: [] };
					}
					part.fragments.push(item);
				});
				if (part.fragments.length) sparse.push(pdfMergeRow(part));
			});
			return sparse;
		}
		var ordered = [];
		var first = [];
		var second = [];
		function flush() {
			// Once columns are identified, read each one top to bottom. OCR
			// word spacing inside a column must not create more columns.
			ordered = ordered.concat(pdfTextRows(first).map(pdfMergeRow), pdfTextRows(second).map(pdfMergeRow));
			first = [];
			second = [];
		}
		rows.forEach(function (row) {
			var before = row.fragments.filter(function (item) { return item.right <= gutter; });
			var after = row.fragments.filter(function (item) { return item.left >= gutter; });
			var smallGap = before.length && after.length
				&& after[0].left - before[before.length - 1].right < (right - left) * 0.025;
			if (smallGap || row.fragments.some(function (item) { return item.left < gutter && item.right > gutter; })) {
				// Titles/abstracts and full-width sections divide a page into bands.
				flush();
				ordered.push(pdfMergeRow(row));
			}
			else row.fragments.forEach(function (item) { (item.left < gutter ? first : second).push(item); });
		});
		flush();
		return ordered;
	}

	function pdfBodyFontSize(page) {
		var sizes = Object.create(null);
		page.lines.forEach(function (line) {
			if (line.y < page.height * 0.12 || line.y > page.height * 0.85
				|| line.right < page.width * 0.15 || line.left > page.width * 0.85) return;
			var key = Math.round(line.size * 2) / 2;
			sizes[key] = (sizes[key] || 0) + line.text.trim().length;
		});
		var best = 0;
		Object.keys(sizes).forEach(function (key) {
			if (!best || sizes[key] > sizes[best]) best = Number(key);
		});
		return best;
	}

	function pdfRunningLineKey(line, page) {
		var edge = line.y < page.height * 0.15 ? 'top:' : line.y > page.height * 0.75 ? 'bottom:' : '';
		if (!edge) return '';
		return edge + line.text.trim().toLowerCase().replace(/\d+/g, '#').replace(/[^\p{L}#]+/gu, '');
	}

	function pdfSpeechText(pages, onPage) {
		var repeated = Object.create(null);
		pages.forEach(function (page) {
			var seen = new Set();
			page.lines.forEach(function (line) {
				var key = pdfRunningLineKey(line, page);
				if (key && !seen.has(key)) {
					seen.add(key);
					repeated[key] = (repeated[key] || 0) + 1;
				}
			});
		});
		return pages.map(function (page, index) {
			if (isPdfMetadataPage(page)) return '';
			var text = pdfBodyLines(page, repeated).map(function (line) { return line.text.trim(); }).join('\n');
			if (onPage) onPage(text, index + 1);
			return text;
		}).filter(Boolean).join('\n\n');
	}

	function isPdfMetadataPage(page) {
		var text = page.lines.map(function (line) { return line.text; }).join('\n');
		var labels = text.match(/(?:^|\n)\s*(?:Author\(s\)|Source|Published by|Stable URL|Accessibility support):/gi) || [];
		return labels.length >= 3 && /jstor\.org|JSTOR archive|digital archive/i.test(text);
	}

	function pdfNoteLines(page) {
		var notes = new Set();
		var sorted = page.lines.slice().sort(function (a, b) { return a.y - b.y; });
		sorted.forEach(function (line, index) {
			if (line.y < page.height * 0.55) return;
			// Use nearby text in the same column, not a page-wide font estimate:
			// a large abstract must not make the entire article look like notes.
			var above = sorted.slice(0, index).filter(function (other) {
				return other.y < line.y - line.size * 0.6
					&& Math.min(other.right, line.right) - Math.max(other.left, line.left)
						> Math.min(other.right - other.left, line.right - line.left) * 0.5;
			}).slice(-5);
			var previous = above[above.length - 1];
			if (!previous) return;
			if (notes.has(previous) && line.size <= previous.size * 1.12 && line.y - previous.y < previous.size * 2.5) {
				notes.add(line);
				return;
			}
			var sizes = above.filter(function (other) { return !notes.has(other); }).map(function (other) { return other.size; }).sort(function (a, b) { return a - b; });
			var localSize = sizes[Math.floor(sizes.length / 2)] || previous.size;
			// Require both a smaller block and a separator gap or note marker.
			// Size alone is unreliable in OCR text layers, even within one line.
			var sameColumn = Math.abs(line.left - previous.left) < localSize * 2
				&& previous.right - previous.left < (line.right - line.left) * 1.4;
			var below = sorted.slice(index + 1).find(function (other) {
				return other.y > line.y + line.size * 0.6 && Math.abs(other.left - line.left) < localSize * 2;
			});
			var smallBlock = !below || below.size <= line.size * 1.15;
			if (line.size < localSize * 0.85 && ((sameColumn && smallBlock && line.y - previous.y > localSize * 2)
				|| /^\s*(?:\d{1,3}[.)]?|[*†‡])\s+\S/.test(line.text))) notes.add(line);
		});
		return notes;
	}

	function pdfBodyLines(page, repeated) {
		repeated = repeated || {};
		var bodySize = pdfBodyFontSize(page);
		var notes = pdfNoteLines(page);
		var bodyLines = page.lines.filter(function (line) {
			return line.size >= bodySize * 0.7 && line.right - line.left > page.width * 0.2 && line.text.length > 35
				&& line.y > page.height * 0.12 && line.y < page.height * 0.88;
		});
		var left = bodyLines.length ? Math.min.apply(null, bodyLines.map(function (line) { return line.left; })) : 0;
		var right = bodyLines.length ? Math.max.apply(null, bodyLines.map(function (line) { return line.right; })) : page.width;
		var lastBodyY = Math.max.apply(null, bodyLines.map(function (line) { return line.y; }));
		return page.lines.filter(function (line) {
			var text = line.text.trim();
			if (!text || isPublisherNotice(text) || notes.has(line)) return false;
			if (line.right < page.width * 0.055 || line.left > page.width * 0.945
				|| line.y < page.height * 0.035 || line.y > page.height * 0.96) return false;
			var runningKey = pdfRunningLineKey(line, page);
			var runningStyle = line.y < page.height * 0.08 || line.y > page.height * 0.9
				|| (bodySize && line.size < bodySize * 0.9);
			if (runningKey && runningStyle && repeated[runningKey] >= 2) return false;
			var beyondBody = line.y > lastBodyY + bodySize;
			var edge = line.y < page.height * 0.08 || (line.y > page.height * 0.75 && beyondBody);
			if (edge && (/^(?:\d+|[ivxlcdm]+)$/i.test(text)
				|| (bodySize && line.size < bodySize * 0.9))) return false;
			if (bodySize && line.size < bodySize * 0.9
				&& (line.right < left - bodySize || line.left > right + bodySize)) return false;
			return true;
		});
	}

	function fetchPdfDocumentText(pdf) {
		if (pdfSpeechCache.has(pdf)) return pdfSpeechCache.get(pdf);
		var pages = [];
		function next(number) {
			if (number > pdf.numPages) {
				var tokens = [];
				var text = pdfSpeechText(pages, function (pageText, pageNumber) {
					readAlongTokens(normalizeForSpeech(pageText)).words.forEach(function (word) {
						tokens.push({ norm: normalizedMatchWord(word), page: pageNumber });
					});
				});
				if (!text.trim()) throw new Error('No readable body text in this PDF — select text to read it instead');
				pdfSurfaceCache.set(pdf, tokens);
				return text;
			}
			return pdf.getPage(number).then(function (page) {
				return Promise.all([
					page.getTextContent({ includeMarkedContent: true }),
					page.getStructTree ? page.getStructTree().catch(function () { return null; }) : null
				]).then(function (results) {
					pages.push(pdfPageLines(results[0], page.getViewport({ scale: 1 }), results[1]));
					return next(number + 1);
				});
			});
		}
		var pending = Promise.resolve().then(function () { return next(1); }).catch(function (error) {
			pdfSpeechCache.delete(pdf);
			throw error;
		});
		pdfSpeechCache.set(pdf, pending);
		return pending;
	}

	function fetchDocumentText() {
		var app = readerPdfApplication();
		if (app) {
			if (!app.pdfDocument) return Promise.reject(new Error('PDF is still loading — try Read aloud again in a moment'));
			return fetchPdfDocumentText(app.pdfDocument);
		}
		// EPUBs and snapshots still use the desktop client's full-text index.
		var key = attachmentKey();
		if (!key) return Promise.reject(new Error('No attachment open'));
		if (!WL.userId || !WL.apiKey) {
			return Promise.reject(new Error('Library credentials unavailable'));
		}
		return fetch('/users/' + encodeURIComponent(WL.userId)
			+ '/items/' + encodeURIComponent(key) + '/fulltext', {
			headers: { 'Zotero-API-Key': WL.apiKey }
		}).then(function (response) {
			if (response.status === 404) {
				throw new Error(
					'No indexed full text for this attachment — select text to read it instead'
				);
			}
			if (!response.ok) {
				throw new Error('Could not load full text (HTTP ' + response.status + ')');
			}
			return response.json();
		}).then(function (body) {
			var content = body && body.content ? String(body.content) : '';
			if (!content.trim()) {
				throw new Error(
					'No indexed full text for this attachment — select text to read it instead'
				);
			}
			return content;
		});
	}

	function readDocument() {
		var key = attachmentKey();
		var request = ++documentReadRequest;
		showBar();
		setPhase('loading');
		setError(null);
		fetchDocumentText().then(function (text) {
			if (request !== documentReadRequest || attachmentKey() !== key) return;
			startRun('document', text, { attachmentKey: key });
		}).catch(function (err) {
			if (request !== documentReadRequest || attachmentKey() !== key) return;
			showBar();
			setError(err && err.message ? err.message : 'Could not load full text');
		});
	}

	function readDocumentFromSurfaceHit(hit) {
		var previous = run;
		var key = attachmentKey();
		var request = ++documentReadRequest;
		var autoplay = previous.loading ? previous.autoplay : !!(audio && !audio.paused);
		previous.loading = true;
		previous.autoplay = autoplay;
		previous.playRequest = {};
		if (audio) audio.pause();
		setPhase('loading');
		fetchDocumentText().then(function (text) {
			if (request !== documentReadRequest || run !== previous || attachmentKey() !== key) return;
			if (!startRun('document', text, { attachmentKey: key, surfaceHit: hit, autoplay: autoplay })) {
				throw new Error('Could not find that word in the document');
			}
		}).catch(function (err) {
			if (request !== documentReadRequest || run !== previous || attachmentKey() !== key) return;
			previous.loading = false;
			if (!audio || !audio.src) previous.failed = previous.index;
			setPhase('paused');
			setError(err && err.message ? err.message : 'Could not load full text');
		});
	}

	// ------------------------------------------------------ selection popup
	//
	// The reader is a same-origin iframe, and EPUB/snapshot views nest another
	// same-origin iframe inside it, so selections have to be watched in every
	// frame and their rects translated back into top-document coordinates.

	function sameOriginDoc(frame) {
		try {
			// Touching contentDocument on a cross-origin frame throws; a frame
			// that has not navigated yet returns an about:blank document.
			return frame.contentDocument || null;
		}
		catch (e) {
			return null;
		}
	}

	/** Every same-origin document reachable from the reader iframe, inclusive. */
	function readerDocuments() {
		var docs = [];
		var root = document.querySelector('.reader-wrapper > iframe');
		var rootDoc = root && sameOriginDoc(root);
		if (!rootDoc) return docs;
		var queue = [rootDoc];
		while (queue.length) {
			var doc = queue.shift();
			docs.push(doc);
			var frames = doc.querySelectorAll('iframe');
			for (var i = 0; i < frames.length; i++) {
				var nested = sameOriginDoc(frames[i]);
				if (nested && docs.indexOf(nested) === -1) queue.push(nested);
			}
		}
		return docs;
	}

	/**
	 * Offset of `doc`'s viewport within the top document, accumulated up the
	 * frame chain — a selection rect inside a nested EPUB frame is relative to
	 * that frame, not the page.
	 */
	function frameOffset(doc) {
		var x = 0;
		var y = 0;
		var win = doc.defaultView;
		while (win && win !== window) {
			var frameEl = win.frameElement;
			if (!frameEl) break;
			var rect = frameEl.getBoundingClientRect();
			x += rect.left;
			y += rect.top;
			win = frameEl.ownerDocument.defaultView;
		}
		return { x: x, y: y };
	}

	function hideSelectionButton() {
		if (ui.selBtn && ui.selBtn.parentNode) {
			ui.selBtn.parentNode.removeChild(ui.selBtn);
		}
	}

	function showSelectionButton(text, rect, offset) {
		if (!ui.selBtn) {
			ui.selBtn = el('button', 'ztts-selection', { type: 'button' });
			ui.selBtn.appendChild(icon(ICONS.play));
			ui.selBtn.appendChild(document.createTextNode(' Read selection'));
			ui.selBtn.addEventListener('mousedown', function (e) {
				// mousedown, not click: clicking clears the selection in some
				// browsers before the click handler ever runs.
				e.preventDefault();
			});
			ui.selBtn.addEventListener('click', function () {
				var pending = ui.selBtn.__text;
				hideSelectionButton();
				if (pending) startRun('selection', pending);
			});
		}
		ui.selBtn.__text = text;
		if (ui.selBtn.parentNode !== document.body) document.body.appendChild(ui.selBtn);
		// Above the selection when there is room, below it when there is not.
		var top = offset.y + rect.top - 40;
		if (top < 8) top = offset.y + rect.bottom + 8;
		ui.selBtn.style.left = Math.max(8, offset.x + rect.left) + 'px';
		ui.selBtn.style.top = top + 'px';
	}

	function handleSelectionIn(doc) {
		var selection = doc.getSelection && doc.getSelection();
		var text = selectionSpeechText(doc, selection);
		if (!selection || !selection.rangeCount || text.trim().length < 2) {
			hideSelectionButton();
			return;
		}
		var rect = selection.getRangeAt(0).getBoundingClientRect();
		if (!rect || (rect.width === 0 && rect.height === 0)) {
			hideSelectionButton();
			return;
		}
		showSelectionButton(text, rect, frameOffset(doc));
	}

	function selectionSpeechText(doc, selection) {
		if (!selection || !selection.rangeCount || selection.isCollapsed) return '';
		var root = surfaceRootForDoc(doc);
		if (!root) return '';
		var walker = doc.createTreeWalker(root, 4);
		var pages = new Map();
		var nodes = [];
		var node;
		while ((node = walker.nextNode())) {
			if (!acceptsSurfaceTextNode(node, true)) continue;
			var line = {
				node: node, text: node.nodeValue,
				block: node.parentElement.closest('p, div, li, h1, h2, h3, h4, h5, h6, section, blockquote, tr, pre')
			};
			var page = node.parentElement.closest('.page');
			if (page) {
				var rect = page.getBoundingClientRect();
				var range = doc.createRange();
				range.selectNodeContents(node);
				var bounds = range.getBoundingClientRect();
				if (!bounds.width || !bounds.height) continue;
				line.left = bounds.left - rect.left;
				line.right = bounds.right - rect.left;
				line.y = bounds.bottom - rect.top;
				line.size = bounds.height;
				if (!pages.has(page)) pages.set(page, { width: rect.width, height: rect.height, lines: [] });
				pages.get(page).lines.push(line);
			}
			else line.accepted = true;
			nodes.push(line);
		}
		pages.forEach(function (page) {
			var base = nodes.indexOf(page.lines[0]);
			page.lines = pdfReadingOrder(page.lines.filter(function (line) { return line.text.trim(); }), 0, page.width);
			if (isPdfMetadataPage(page)) return;
			var index = 0;
			pdfBodyLines(page).forEach(function (line) {
				line.fragments.forEach(function (fragment) {
					fragment = fragment.sourceFragment || fragment;
					fragment.accepted = true;
					fragment.speechLine = line;
					fragment.order = base + index++ / (nodes.length + 1);
				});
			});
		});
		nodes.forEach(function (line, index) { if (line.order === undefined) line.order = index; });
		nodes.sort(function (a, b) { return a.order - b.order; });
		var text = '';
		var previous = null;
		for (var i = 0; i < selection.rangeCount; i++) {
			var selected = selection.getRangeAt(i);
			nodes.forEach(function (line) {
				if (!line.accepted || !selected.intersectsNode(line.node)) return;
				var start = selected.startContainer === line.node ? selected.startOffset : 0;
				var end = selected.endContainer === line.node ? selected.endOffset : line.text.length;
				var piece = line.text.slice(start, end);
				if (!piece) return;
				if (previous && (previous.block !== line.block
					|| (line.speechLine && previous.speechLine !== line.speechLine))) text += '\n';
				else if (previous && line.y !== undefined && line.left - previous.right > line.size * 0.12
					&& !/\s$/.test(text) && !/^\s/.test(piece)) text += ' ';
				text += piece;
				previous = line;
			});
		}
		return text;
	}

	/**
	 * Watch a frame's selection. `selectionchange` fires continuously while
	 * dragging, so the button is only placed once the pointer or key is
	 * released — otherwise it chases the cursor across the page.
	 */
	function watchDocument(doc) {
		if (!doc || doc.__zttsWatched) return;
		doc.__zttsWatched = true;
		watchSurfaceNavigation(doc);
		var settle = function () {
			setTimeout(function () { handleSelectionIn(doc); }, 0);
		};
		var tapOptions = { capture: true, passive: false };
		doc.addEventListener('mouseup', settle, true);
		doc.addEventListener('keyup', settle, true);
		doc.addEventListener('mousedown', function () {
			hideSelectionButton();
		}, true);
		doc.addEventListener('click', function (e) {
			seekToSurfaceClick(doc, e);
		}, true);
		if (doc.defaultView && doc.defaultView.PointerEvent) {
			doc.addEventListener('pointerdown', function (e) {
				if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
				rememberSurfaceTap(doc, e.clientX, e.clientY, e.target, e.pointerId);
			}, true);
			doc.addEventListener('pointercancel', function () {
				doc.__zttsTapStart = null;
			}, true);
			doc.addEventListener('pointerup', function (e) {
				if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
				finishSurfaceTap(doc, e.clientX, e.clientY, e.target, e.pointerId, e);
			}, tapOptions);
		}
		else {
			doc.addEventListener('touchstart', function (e) {
				if (!e.touches || e.touches.length !== 1) return;
				var touch = e.touches[0];
				rememberSurfaceTap(doc, touch.clientX, touch.clientY, e.target, touch.identifier);
			}, true);
			doc.addEventListener('touchcancel', function () {
				doc.__zttsTapStart = null;
			}, true);
			doc.addEventListener('touchend', function (e) {
				if (!e.changedTouches || e.changedTouches.length !== 1) return;
				var touch = e.changedTouches[0];
				finishSurfaceTap(doc, touch.clientX, touch.clientY, e.target, touch.identifier, e);
			}, tapOptions);
		}
		doc.addEventListener('scroll', function (event) {
			hideSelectionButton();
			if (run) {
				var target = event.target;
				var element = target === doc ? doc.scrollingElement : target;
				var motion = run.surfaceScroll;
				if ((!motion || motion.doc !== doc || motion.element !== element)
					&& !(target.closest && target.closest('.ztts-bar, #sidebarContainer, .sidebar'))) {
					suspendSurfaceFollow();
				}
				window.requestAnimationFrame(function () {
					paintHighlight(true, false);
				});
			}
		}, true);
	}

	/**
	 * Re-watch a frame as soon as it finishes navigating.
	 *
	 * A frame's document is REPLACED on navigation, so the listeners attached
	 * to the previous one (about:blank, before the reader loads its view) do
	 * not carry over. Without this the poll below is the only thing that
	 * notices, leaving a window of up to a second after a document opens where
	 * selecting text does nothing.
	 */
	function hookFrameLoads(doc) {
		var frames = doc.querySelectorAll('iframe');
		for (var i = 0; i < frames.length; i++) {
			if (frames[i].__zttsLoadHooked) continue;
			frames[i].__zttsLoadHooked = true;
			frames[i].addEventListener('load', watchReaderFrames);
		}
	}

	function watchReaderFrames() {
		hookFrameLoads(document);
		readerDocuments().forEach(function (doc) {
			watchDocument(doc);
			hookFrameLoads(doc);
		});
	}

	// ------------------------------------------------------------ entry point

	function teardown() {
		stopRun();
		hideSelectionButton();
		if (ui.bar && ui.bar.parentNode) ui.bar.parentNode.removeChild(ui.bar);
	}

	/**
	 * The SPA mounts and unmounts the reader on navigation, and the reader
	 * builds its frames asynchronously, so poll the DOM rather than trying to
	 * hook React's lifecycle from outside.
	 */
	function sync() {
		var wrapper = document.querySelector('.reader-wrapper');
		if (!wrapper) {
			// Navigated away from the reader: stop talking and let go of the UI.
			if (ui.bar && ui.bar.parentNode) teardown();
			return;
		}
		ensureBar();
		watchReaderFrames();
	}

	document.addEventListener('keydown', function (e) {
		if (!run) return;
		// Never steal keys from a field the user is typing in.
		var target = e.target;
		var tag = target && target.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
			|| tag === 'BUTTON' || (target && target.isContentEditable)) return;
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (e.key === ' ') { e.preventDefault(); togglePlay(); }
		else if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(-SEEK_STEP); }
		else if (e.key === 'ArrowRight') { e.preventDefault(); seekBy(SEEK_STEP); }
		else if (e.key === 'Escape') { e.preventDefault(); stopRun(); }
	}, true);

	window.addEventListener('pagehide', function () {
		saveReadProgress(true);
	});

	function start() {
		sync();
		new MutationObserver(sync).observe(document.body, { childList: true, subtree: true });
		// Frames are picked up on their `load` event, but a frame that is
		// already loaded when this script runs never fires one, and the EPUB
		// view swaps its inner document without a top-level mutation. A slow
		// poll is the backstop for both.
		setInterval(watchReaderFrames, 1000);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start);
	}
	else {
		start();
	}
})();
