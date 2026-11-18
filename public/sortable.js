import { fill } from './dom.js';

// Drag-to-reorder for a list whose rows are redrawn from server data.
// A redraw during a drag would detach the dragged row, and the next dragover would put it back as a duplicate,
// so fill() skips redraws until the drag ends. The drag end then asks for a fresh redraw through onSettle,
// unless the drop moved a row, in which case onMove's reload redraws the list.
// onMove gets the row's new index and `before`, the `data-id` of the row it now sits in front of, null at the end.
export function sortable(list, { onMove, onSettle = () => {} }) {
  let dragged = null;
  let from = -1;

  const finish = () => {
    const row = dragged;
    dragged = null;
    const position = [...list.children].indexOf(row);
    if (position !== from) onMove(row, { position, before: row.nextElementSibling?.dataset.id ?? null });
    else onSettle();
  };

  list.addEventListener('dragover', (e) => {
    if (!dragged) return;
    e.preventDefault();
    const over = e.target.closest?.('li');
    if (!over || over === dragged || over.parentNode !== list) return;
    const { top, height } = over.getBoundingClientRect();
    list.insertBefore(dragged, e.clientY > top + height / 2 ? over.nextElementSibling : over);
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragged) finish();
  });

  return {
    fill(...rows) {
      if (!dragged) fill(list, ...rows);
    },
    // A drag that ends outside the list puts the row back where it started.
    attach(row) {
      row.addEventListener('dragstart', (e) => {
        dragged = row;
        from = [...list.children].indexOf(row);
        e.dataTransfer.effectAllowed = 'move';
        requestAnimationFrame(() => row.classList.add('dragging'));
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        if (!dragged) return;
        dragged = null;
        list.insertBefore(row, [...list.children].filter((r) => r !== row)[from] ?? null);
        onSettle();
      });
    },
  };
}
