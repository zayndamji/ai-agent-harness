// In-page dialogs in place of the browser's prompt(), confirm() and alert(),
// which embedded browsers (such as an app's browser pane) may not show.

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};

// Resolves with the typed text (input), true (confirm), or null when cancelled.
function open({ title, message, input, okLabel = 'OK', cancelLabel = 'Cancel', danger = false, alertOnly = false }) {
  return new Promise((resolve) => {
    const dialog = el('dialog', 'modal');
    const form = el('form', 'modal-body');
    form.method = 'dialog';
    form.append(el('h2', 'modal-title', title));
    if (message) form.append(el('p', 'modal-text', message));
    let field = null;
    if (input) {
      field = el('input', 'modal-input');
      field.type = 'text';
      field.placeholder = input.placeholder || '';
      field.value = input.value || '';
      field.autocomplete = 'off';
      field.spellcheck = false;
      form.append(field);
    }
    const actions = el('div', 'modal-actions');
    const ok = el('button', danger ? 'danger' : '', okLabel);
    ok.type = 'submit';
    if (!alertOnly) {
      const cancel = el('button', 'ghost', cancelLabel);
      cancel.type = 'button';
      cancel.addEventListener('click', () => dialog.close('cancel'));
      actions.append(cancel);
    }
    actions.append(ok);
    form.append(actions);
    dialog.append(form);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (field && !field.value.trim()) return field.focus();
      dialog.close('ok');
    });
    dialog.addEventListener('close', () => {
      const confirmed = dialog.returnValue === 'ok';
      dialog.remove();
      resolve(!confirmed ? null : field ? field.value.trim() : true);
    });
    // A click on the backdrop cancels.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close('cancel');
    });
    document.body.append(dialog);
    dialog.showModal();
    (field || ok).focus();
  });
}

export const ask = (title, opts = {}) => open({ title, input: { placeholder: opts.placeholder, value: opts.value }, okLabel: opts.okLabel || 'Create', message: opts.message });
export const confirmAction = (title, message, okLabel = 'Continue', danger = false) => open({ title, message, okLabel, danger }).then(Boolean);
export const notice = (title, message) => open({ title, message, alertOnly: true });
