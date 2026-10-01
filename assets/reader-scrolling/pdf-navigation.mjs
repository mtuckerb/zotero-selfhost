// Keep successive page-button/key presses relative to the destination while
// PDF.js updates its current page from intermediate animation frames.
const pendingPages = new WeakMap();
const wheelAnimations = new WeakMap();

function cancelWheelScroll(container) {
	wheelAnimations.get(container)?.cancel();
}

export function zoteroScrollElement(container, options) {
	cancelWheelScroll(container);
	container.scrollTo(options);
}

export function zoteroInstallWheelScrolling(viewer) {
	const container = viewer.container;
	const win = container.ownerDocument.defaultView;
	// Let a finger pan the PDF normally, but reserve multi-touch for PDF.js's
	// pinch handler instead of the browser viewport. A pinch that starts in a
	// nested browsing context is constrained by every containing frame, so
	// claim the same gesture at both reader iframe boundaries as well.
	container.style.touchAction = 'pan-x pan-y';
	for (let current = win; current?.frameElement;) {
		const frame = current.frameElement;
		frame.style.touchAction = 'pan-x pan-y';
		current = frame.ownerDocument?.defaultView;
	}
	const cancel = () => cancelWheelScroll(container);
	for (const type of ['pointerdown', 'touchstart']) {
		container.addEventListener(type, cancel, { passive: true });
	}
	win.addEventListener('keydown', cancel, { passive: true });
	container.addEventListener('wheel', event => {
		if (event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey
			|| event.altKey || event.shiftKey || !event.deltaY || event.deltaX
			|| viewer.scrollMode !== 0 || viewer.isInPresentationMode
			|| win.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			cancel();
			return;
		}
		// Leave inputs and independently scrollable controls to the browser.
		for (let node = event.target; node && node !== container; node = node.parentElement) {
			if (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)) return;
			if (node.scrollHeight > node.clientHeight
				&& /^(auto|scroll)$/.test(win.getComputedStyle(node).overflowY)) return;
		}
		const unit = event.deltaMode === 1
			? parseFloat(win.getComputedStyle(container).lineHeight) || 16
			: event.deltaMode === 2 ? container.clientHeight : 1;
		const current = wheelAnimations.get(container);
		const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
		const target = Math.max(0, Math.min(maxTop,
			(current?.target ?? container.scrollTop) + event.deltaY * unit));
		if (!current && target === container.scrollTop) return;
		event.preventDefault();
		pendingPages.get(viewer)?.clear();
		cancel();
		// Stop a native page-button animation before starting a wheel gesture.
		container.scrollTo({ top: container.scrollTop, behavior: 'instant' });
		const start = container.scrollTop;
		const started = win.performance.now();
		let frame;
		const animation = { target, cancel() {
			win.cancelAnimationFrame(frame);
			wheelAnimations.delete(container);
		} };
		wheelAnimations.set(container, animation);
		const tick = now => {
			const progress = Math.min(1, (now - started) / 180);
			const eased = 1 - (1 - progress) ** 3;
			container.scrollTo({ top: start + (target - start) * eased, behavior: 'instant' });
			if (progress < 1) frame = win.requestAnimationFrame(tick);
			else wheelAnimations.delete(container);
		};
		frame = win.requestAnimationFrame(tick);
	}, { passive: false });
}

export function zoteroPageNumber(viewer) {
	return pendingPages.get(viewer)?.pageNumber ?? viewer._currentPageNumber;
}

export function zoteroScrollPage(viewer, pageNumber) {
	cancelWheelScroll(viewer.container);
	pendingPages.get(viewer)?.clear();
	const container = viewer.container;
	const win = container.ownerDocument.defaultView;
	const smooth = viewer.scrollMode !== 3 && !viewer.isInPresentationMode
		&& !win.matchMedia('(prefers-reduced-motion: reduce)').matches;
	let clear = () => {};
	if (smooth) {
		const cancelEvents = ['scrollend', 'wheel', 'touchstart', 'pointerdown'];
		clear = () => {
			win.clearTimeout(timer);
			for (const type of cancelEvents) container.removeEventListener(type, clear);
			pendingPages.delete(viewer);
		};
		// Fallback for browsers without scrollend, and destinations that are
		// already visible and therefore produce no scroll event.
		const timer = win.setTimeout(clear, 1500);
		for (const type of cancelEvents) container.addEventListener(type, clear, { passive: true });
		pendingPages.set(viewer, { pageNumber, clear });
	}
	const previousBehavior = viewer._zoteroScrollBehavior;
	try {
		viewer._zoteroScrollBehavior = smooth ? 'smooth' : 'instant';
		viewer.currentPageNumber = pageNumber;
	}
	catch (error) {
		clear();
		throw error;
	}
	finally {
		// Loading, zooming, links, and restoring a reading position keep the
		// normal PDF.js behavior. Only previous/next page navigation animates.
		viewer._zoteroScrollBehavior = previousBehavior;
	}
}
