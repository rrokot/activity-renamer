// Helpers for driving the name dialog. Every action re-renders the panel,
// so element references must be looked up again after each click — exactly the
// way a user reads the dialog again after it changes.

export function openDialog(renamer) {
    renamer.adjustButton.click();
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

// The section headings, top to bottom — the order the dialog reads in.
export function sectionTitles(renamer) {
    return renamer.dialog.querySelectorAll('h4').map(title => title.textContent);
}

// The name is edited as chips: the label renames the place, the ✕ takes it out.
export function chipNames(renamer) {
    return renamer.dialog.querySelectorAll('button')
        .filter(button => button.className === 'activity-renamer-chip-name')
        .map(button => button.textContent);
}

export function nameChip(renamer, name) {
    const rename = renamer.dialog.querySelectorAll('button')
        .find(button => button.className === 'activity-renamer-chip-name'
            && button.textContent === name);
    if (!rename) {
        throw new Error(`No "${name}" chip in the name. Present: ${chipNames(renamer).join(', ')}`);
    }
    return { rename, drop: rename.parentNode.children[1] };
}

// A button in the "Also passed" row of a given place.
export function passedRowButton(renamer, label, place) {
    const button = renamer.dialog.querySelectorAll('button')
        .filter(candidate => candidate.textContent === label)
        .find(candidate => candidate.title.includes(place));
    if (!button) throw new Error(`No "${label}" button for ${place}`);
    return button;
}

export function namePreview(renamer) {
    return renamer.dialog.querySelector('#activity-renamer-name-preview')?.textContent ?? null;
}
