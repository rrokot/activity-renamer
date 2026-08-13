// Helpers for driving the inline name panel. Every action re-renders it, so
// element references must be looked up again after each click.

export function openPanel(renamer) {
    renamer.editNameButton.click();
    return renamer.panel;
}

export function panelButtons(renamer) {
    return renamer.panel.querySelectorAll('button');
}

export function panelButton(renamer, text) {
    const button = panelButtons(renamer).find(candidate => candidate.textContent === text);
    if (!button) {
        throw new Error(`No "${text}" button in the panel. Present: ${
            panelButtons(renamer).map(candidate => candidate.textContent).join(', ')}`);
    }
    return button;
}

export function panelField(renamer, id) {
    const field = renamer.panel.querySelector(`#${id}`);
    if (!field) throw new Error(`No #${id} in the panel`);
    return field;
}

// Setting .value alone never reaches a live-updating form.
export function typeInto(field, value) {
    field.value = value;
    field.dispatchEvent({ type: 'input' });
    return field;
}

export function activateGroup(field) {
    const button = field.parentNode.querySelector('button');
    if (!button) throw new Error('No action button beside the field');
    button.click();
}

export function panelText(renamer) {
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
    visit(renamer.panel);
    return parts.join(' | ');
}

// The section headings, top to bottom — the order the panel reads in.
export function sectionTitles(renamer) {
    return renamer.panel.querySelectorAll('h4').map(title => title.textContent);
}

// The name is edited as chips: the label renames the place, the ✕ takes it out.
export function chipNames(renamer) {
    return renamer.panel.querySelectorAll('button')
        .filter(button => button.className === 'activity-renamer-chip-name')
        .map(button => button.textContent);
}

export function nameChip(renamer, name) {
    const rename = renamer.panel.querySelectorAll('button')
        .find(button => button.className === 'activity-renamer-chip-name'
            && button.textContent === name);
    if (!rename) {
        throw new Error(`No "${name}" chip in the name. Present: ${chipNames(renamer).join(', ')}`);
    }
    return { rename, drop: rename.parentNode.children[1] };
}

// A button in the "Also passed" row of a given place.
export function passedRowButton(renamer, label, place) {
    const button = renamer.panel.querySelectorAll('button')
        .filter(candidate => candidate.textContent === label)
        .find(candidate => candidate.title.includes(place));
    if (!button) throw new Error(`No "${label}" button for ${place}`);
    return button;
}
