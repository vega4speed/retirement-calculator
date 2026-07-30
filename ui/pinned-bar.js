// pinned-bar.js — an optional thin bar pinned to the top of the page that mirrors a
// user-chosen subset of the projection's stat tiles (statTileDescriptors, projection-view.js),
// so a change to an assumption is visible without scrolling down to the chart every time. Which
// figures are pinned is a display preference, not plan data — it gets its own localStorage key,
// same reasoning as scenarios.js's separate key, and survives independently of Export/Import.
//
// Pin state ("stuck to the viewport top, scrolled past its normal position") is detected via an
// IntersectionObserver on a zero-height sentinel placed immediately before the bar in the DOM:
// once the sentinel scrolls out of the viewport, the bar (position: sticky; top: 0) is pinned,
// and a CSS class swaps it into a shorter, denser layout.

import { h, clear } from './dom.js';
import { statTileDescriptors } from './projection-view.js';

const STORAGE_KEY = 'retirement-calc:pinned-bar:v1';

function loadSelected() {
  try {
    const arr = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveSelected(ids) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // private-browsing / storage-disabled — the pick just won't persist across reloads.
  }
}

export function createPinnedBar() {
  const selected = new Set(loadSelected());
  let current = null;
  let menuOpen = false;

  const sentinel = h('div', { 'aria-hidden': 'true', style: { height: '1px' } });
  const bar = h('div', { class: 'pinned-bar' });
  // `sentinel` and `bar` must land as siblings of the page's OWN top-level sections (not nested
  // together inside their own little wrapper div) — a sticky element's containing block is its
  // immediate parent, and a wrapper holding only these two ~40px-tall nodes would itself scroll
  // out of view almost immediately, dragging "stuck" bar away with it. As direct children of the
  // real page root, their parent spans the whole page height, so the bar can stay stuck for the
  // full scroll range. Exposed as two nodes rather than one — caller appends both directly.

  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver(
      ([entry]) => bar.classList.toggle('is-pinned', !entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(sentinel);
  }

  function toggle(id, on) {
    if (on) selected.add(id); else selected.delete(id);
    saveSelected([...selected]);
    render();
  }

  function render() {
    clear(bar);
    const descriptors = statTileDescriptors(current);
    const pinned = descriptors.filter((d) => selected.has(d.id));

    const items = pinned.length
      ? pinned.map((d) => h('div', { class: 'pinned-item' },
          h('div', { class: 'pinned-label' }, d.label),
          h('div', { class: 'pinned-value', style: d.accent ? { color: d.accent } : {} }, d.value),
        ))
      : [h('div', { class: 'pinned-empty muted small' },
          descriptors.length ? 'Pick a figure below to pin it here.' : 'Add an account to see figures here.')];

    const menu = menuOpen
      ? h('div', { class: 'pinned-menu' }, ...descriptors.map((d) => h('label', { class: 'pinned-menu-item' },
          h('input', { type: 'checkbox', checked: selected.has(d.id), onchange: (e) => toggle(d.id, e.target.checked) }),
          ` ${d.label}`,
        )))
      : null;

    bar.append(
      h('div', { class: 'pinned-row' },
        h('div', { class: 'pinned-items' }, ...items),
        h('button', { class: 'ghost pinned-gear', onclick: () => { menuOpen = !menuOpen; render(); } }, menuOpen ? 'Done' : 'Pin figures ▾'),
      ),
      ...(menu ? [menu] : []),
    );
  }

  render();

  return {
    sentinel, el: bar,
    render(result) { current = result; render(); },
    clearView() { current = null; render(); },
  };
}
