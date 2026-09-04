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
	var VOICE = CFG.voice || 'af_heart';
	var FORMAT = CFG.format || 'mp3';
	var SEEK_STEP = Number(CFG.seekStepSec) > 0 ? Number(CFG.seekStepSec) : 15;
	var SPEEDS = Array.isArray(CFG.speeds) && CFG.speeds.length
		? CFG.speeds
		: [0.75, 1, 1.25, 1.5, 1.75, 2];

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
		return String(text || '')
			.replace(/\r\n?/g, '\n')
			// Soft hyphen or ASCII hyphen at a line break = one split word.
			.replace(/(\w)[-\u00AD\u2010]\n(\w)/g, '$1$2')
			// Collapse runs of blank lines to exactly one paragraph break.
			.replace(/\n{2,}/g, '\n\n')
			// A lone newline is a line wrap, not a sentence end.
			.replace(/([^\n])\n([^\n])/g, '$1 $2')
			.replace(/[ \t\u00A0]+/g, ' ')
			.trim();
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
				input: text,
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
			return response.blob();
		}).then(function (blob) {
			return URL.createObjectURL(blob);
		});
	}

	// -------------------------------------------------------------- the run
	//
	// One "run" is a single read job: an ordered list of parts plus the index
	// of the part currently loaded. Everything the transport bar does is a
	// mutation of the live run.

	var run = null;
	var audio = null;
	var speed = loadSpeed();
	var voice = loadVoice();

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
			setPhase('paused');
		});
		audio.addEventListener('ended', function () {
			if (!run) return;
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
	}

	function stopRun() {
		if (run) {
			run.controller.abort();
			run.parts.forEach(releasePart);
		}
		run = null;
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
		if (part.url) return Promise.resolve(part.url);
		if (part.pending) return part.pending;
		part.pending = synthesize(part.text, theRun.controller.signal)
			.then(function (url) {
				part.pending = null;
				// A run that was stopped mid-flight must not leak its blob.
				if (run !== theRun) {
					URL.revokeObjectURL(url);
					throw new Error('cancelled');
				}
				part.url = url;
				return url;
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
			stopRun();
			return;
		}
		var theRun = run;
		theRun.index = index;
		theRun.loading = true;
		theRun.failed = null;
		setPhase('loading');
		renderMeta();
		loadPart(theRun, index).then(function (url) {
			if (run !== theRun || theRun.index !== index) return;
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
					if (run !== theRun) return;
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
			if (run !== theRun) return;
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
			if (run === theRun && theRun.index === index) theRun.loading = false;
		});
	}

	/**
	 * Start reading `text`. Re-invoking with the same source toggles the job
	 * off, which is what makes the two entry-point buttons act as toggles.
	 */
	function startRun(source, text) {
		var normalized = normalizeForSpeech(text);
		var key = source + ':' + normalized;
		if (run && run.key === key) {
			stopRun();
			return;
		}
		stopRun();
		var chunks = splitTextForSpeech(normalized, CHUNK_MAX_CHARS);
		if (!chunks.length) {
			showBar();
			setError('Nothing to read');
			return;
		}
		run = {
			key: key,
			source: source,
			index: 0,
			loading: false,
			// Set by seekBy when a +/- step runs off the end of a part; applied
			// once the part it lands in reports a duration.
			pendingSeek: null,
			// Index of a part whose synthesis failed, so Play can retry it.
			failed: null,
			controller: new AbortController(),
			parts: chunks.map(function (t) {
				return { text: t, url: null, pending: null };
			})
		};
		showBar();
		setError(null);
		playPart(0, true);
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
	}

	/**
	 * Apply a seek that was queued before the part it targets had loaded.
	 * Runs on `loadedmetadata`, the first point at which a duration exists.
	 */
	function applyPendingSeek() {
		if (!run || !run.pendingSeek || !audio) return;
		var duration = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
		var pending = run.pendingSeek;
		run.pendingSeek = null;
		if (!duration) return;
		var at = pending.fromEnd ? duration - pending.seconds : pending.seconds;
		audio.currentTime = Math.min(duration, Math.max(0, at));
	}

	/**
	 * Previous part, or restart this one when we are already a few seconds in
	 * — the behaviour every music player has trained people to expect.
	 */
	function previousPart() {
		if (!run || !audio) return;
		if (audio.currentTime > 3 || run.index === 0) {
			audio.currentTime = 0;
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
			return { text: part.text, url: null, pending: null };
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
			title: 'Read this document aloud',
			'aria-label': 'Read this document aloud'
		});
		ui.docBtn.appendChild(icon(ICONS.play));
		ui.docBtn.appendChild(document.createTextNode(' Read aloud'));
		ui.docBtn.addEventListener('click', function () {
			if (run && run.source === 'document') stopRun();
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
			if (audio && audio.src) audio.currentTime = Number(ui.scrub.value);
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

		group.appendChild(button('ztts-btn', 'Stop reading', ICONS.stop, stopRun));

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
		paintProgress();
	}

	function hideBar() {
		if (ui.bar) ui.bar.classList.remove('ztts-playing');
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

	/**
	 * Whole-attachment text, from the Zotero full-text index.
	 *
	 * The reader renders pages lazily, so the DOM only ever holds the few
	 * pages around the viewport — there is nothing to scrape for a whole
	 * document. The dataserver already stores the extracted text the desktop
	 * client uploaded (`GET .../items/<key>/fulltext`), which is the complete
	 * document in one request.
	 */
	function fetchDocumentText() {
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
		showBar();
		setPhase('loading');
		setError(null);
		fetchDocumentText().then(function (text) {
			startRun('document', text);
		}).catch(function (err) {
			showBar();
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
		var text = selection ? String(selection) : '';
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

	/**
	 * Watch a frame's selection. `selectionchange` fires continuously while
	 * dragging, so the button is only placed once the pointer or key is
	 * released — otherwise it chases the cursor across the page.
	 */
	function watchDocument(doc) {
		if (!doc || doc.__zttsWatched) return;
		doc.__zttsWatched = true;
		var settle = function () {
			setTimeout(function () { handleSelectionIn(doc); }, 0);
		};
		doc.addEventListener('mouseup', settle, true);
		doc.addEventListener('keyup', settle, true);
		doc.addEventListener('mousedown', function () {
			hideSelectionButton();
		}, true);
		doc.addEventListener('scroll', hideSelectionButton, true);
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
