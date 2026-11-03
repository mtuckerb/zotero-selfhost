/* Keep disjoint ranges as native annotations so gaps and comments survive. */
window.zoteroAnnotationGroups = (() => {
  const key = 'zoteroAnnotationGroup';
  const group = annotation => ['highlight', 'underline'].includes(annotation.type)
    && typeof annotation.position?.[key] === 'string' ? annotation.position[key] : null;

  function expand(annotations, ids) {
    const selected = new Set(ids);
    const groups = new Set(annotations.filter(a => selected.has(a.id)).map(group).filter(Boolean));
    const expanded = [...new Set([...ids, ...annotations.filter(a => groups.has(group(a))).map(a => a.id)])];
    return expanded.length === ids.length ? ids : expanded;
  }

  function change(reader, ids, separate) {
    const annotations = reader._state.annotations;
    const selected = new Set(expand(annotations, ids));
    const members = annotations.filter(a => selected.has(a.id));
    if (reader._state.readOnly || members.some(a => a.readOnly || a.isExternal)
      || members.length !== selected.size || members.some(a => !['highlight', 'underline'].includes(a.type))
      || (!separate && members.length < 2)) throw new Error('Cannot combine these annotations');
    const value = separate ? null : crypto.randomUUID();
    reader._annotationManager.updateAnnotations(members.map(a => ({
      id: a.id, sortIndex: a.sortIndex, position: { ...a.position, [key]: value }
    })));
    reader._updateState({ selectedAnnotationIDs: members.map(a => a.id) });
  }

  function menu(reader, ids) {
    const selected = new Set(expand(reader._state.annotations, ids));
    const members = reader._state.annotations.filter(a => selected.has(a.id));
    if (!members.length || reader._state.readOnly
      || members.some(a => a.readOnly || a.isExternal || !['highlight', 'underline'].includes(a.type))) return [];
    const groups = new Set(members.map(group));
    const items = [];
    if (members.length > 1 && (groups.size > 1 || groups.has(null))) {
      items.push({ label: 'Combine annotations', onCommand: () => change(reader, [...selected], false) });
    }
    if (members.some(group)) {
      items.push({ label: 'Separate annotations', onCommand: () => change(reader, [...selected], true) });
    }
    return items.length ? [items] : [];
  }

  function sidebar(annotations, render, createElement) {
    const groups = new Map();
    for (const a of annotations) {
      const id = group(a);
      if (id) groups.set(id, [...(groups.get(id) || []), a]);
    }
    const seen = new Set();
    return annotations.flatMap(a => {
      const id = group(a), members = groups.get(id);
      if (!id || members.length < 2) return [render(a)];
      if (seen.has(id)) return [];
      seen.add(id);
      return [createElement('div', { key: `group-${id}`, className: 'annotation-group',
        role: 'group', 'aria-label': `Combined annotation, ${members.length} passages` }, members.map(render))];
    });
  }

  function neighbor(element, offset) {
    const elements = [...element.closest('#annotations').querySelectorAll('.annotation')];
    return elements[elements.indexOf(element) + offset];
  }

  return { expand, menu, sidebar, neighbor };
})();
