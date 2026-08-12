// Helpers for driving the favorites dialog. Every action re-renders the panel,
// so element references must be looked up again after each click — exactly the
// way a user reads the dialog again after it changes.

export function openDialog(renamer) {
    renamer.favoritesButton.click();
    return renamer.dialog;
}

export function dialogButtons(renamer) {
    return renamer.dialog.querySelectorAll('button');
}

export function dialogButton(renamer, text) {
    const button = dialogButtons(renamer).find(candidate => candidate.textContent === text);
    if (!button) {
        throw new Error(`No "${text}" button in the dialog. Present: ${
            dialogButtons(renamer).map(candidate => candidate.textContent).join(', ')}`);
    }
    return button;
}

export function dialogField(renamer, id) {
    const field = renamer.dialog.querySelector(`#${id}`);
    if (!field) throw new Error(`No #${id} in the dialog`);
    return field;
}

// Setting .value alone never reaches a live-updating form.
export function typeInto(field, value) {
    field.value = value;
    field.dispatchEvent({ type: 'input' });
    return field;
}

export function submitForm(field) {
    field.parentNode.dispatchEvent({ type: 'submit' });
}

export function dialogText(renamer) {
    const parts = [];
    const visit = element => {
        for (const child of element.children) {
            if (child.textNode !== undefined) {
                parts.push(child.textNode);
                continue;
            }
            if (child.textContent) parts.push(child.textContent);
            visit(child);
        }
    };
    visit(renamer.dialog);
    return parts.join(' | ');
}

export function namePreview(renamer) {
    return renamer.dialog.querySelector('#strava-route-name-preview')?.textContent ?? null;
}
