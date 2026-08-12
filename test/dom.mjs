// Minimal DOM/browser stubs: just enough of the platform for the userscript to
// run under Node without any dependency. Everything the script touches on the
// Strava edit page is modelled here; anything else is deliberately absent so a
// new platform dependency fails loudly instead of silently passing.

class FakeClassList {
    constructor() {
        this.tokens = new Set();
    }

    add(...names) {
        for (const name of names) this.tokens.add(name);
    }

    contains(name) {
        return this.tokens.has(name);
    }
}

export class FakeElement {
    constructor(tagName, ownerDocument) {
        this.tagName = String(tagName).toLowerCase();
        this.ownerDocument = ownerDocument;
        this.children = [];
        this.parentNode = null;
        this.attributes = new Map();
        this.style = {};
        this.dataset = {};
        this.classList = new FakeClassList();
        this.listeners = new Map();
        this.textContent = '';
        this.value = '';
        this.disabled = false;
        this.focused = false;
    }

    get id() {
        return this.attributes.get('id') || '';
    }

    set id(value) {
        this.attributes.set('id', String(value));
    }

    get name() {
        return this.attributes.get('name') || '';
    }

    set name(value) {
        this.attributes.set('name', String(value));
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    append(...nodes) {
        for (const node of nodes) {
            if (typeof node === 'string') {
                this.children.push({ textNode: node });
                continue;
            }
            node.parentNode?.removeChild(node);
            node.parentNode = this;
            this.children.push(node);
        }
    }

    appendChild(node) {
        this.append(node);
        return node;
    }

    insertBefore(node, reference) {
        const index = this.children.indexOf(reference);
        node.parentNode?.removeChild(node);
        node.parentNode = this;
        this.children.splice(index < 0 ? this.children.length : index, 0, node);
        return node;
    }

    removeChild(node) {
        const index = this.children.indexOf(node);
        if (index >= 0) this.children.splice(index, 1);
        node.parentNode = null;
        return node;
    }

    replaceChildren(...nodes) {
        for (const child of this.children) {
            if (child.parentNode === this) child.parentNode = null;
        }
        this.children = [];
        this.append(...nodes);
    }

    remove() {
        this.parentNode?.removeChild(this);
    }

    focus() {
        this.focused = true;
    }

    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(handler);
    }

    removeEventListener(type, handler) {
        const handlers = this.listeners.get(type);
        if (!handlers) return;
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
    }

    dispatchEvent(event) {
        const target = { ...event, target: event.target || this, preventDefault() {} };
        for (const handler of this.listeners.get(event.type)?.slice() || []) {
            handler(target);
        }
        return true;
    }

    // Test helper: fire a listener the way a real click would.
    click(extra = {}) {
        return this.dispatchEvent({ type: 'click', ...extra });
    }

    * walk() {
        for (const child of this.children) {
            if (child.textNode !== undefined) continue;
            yield child;
            yield* child.walk();
        }
    }

    matches(selector) {
        const byId = selector.match(/^#(.+)$/);
        if (byId) return this.id === byId[1];

        const byAttribute = selector.match(/^([a-z0-9]*)\[(.+)=["'](.*)["']\]$/i);
        if (byAttribute) {
            const [, tagName, attribute, value] = byAttribute;
            return (!tagName || this.tagName === tagName.toLowerCase())
                && this.getAttribute(attribute) === value;
        }
        return this.tagName === selector.toLowerCase();
    }

    querySelector(selector) {
        for (const element of this.walk()) {
            if (element.matches(selector)) return element;
        }
        return null;
    }

    querySelectorAll(selector) {
        return Array.from(this.walk()).filter(element => element.matches(selector));
    }

    getElementsByTagName(tagName) {
        return Array.from(this.walk())
            .filter(element => element.tagName === String(tagName).toLowerCase());
    }
}

class FakeDocument extends FakeElement {
    constructor() {
        super('#document', null);
        this.ownerDocument = this;
        this.body = new FakeElement('body', this);
        this.append(this.body);
    }

    createElement(tagName) {
        return new FakeElement(tagName, this);
    }

    getElementById(id) {
        return this.querySelector(`#${id}`);
    }
}

export function createLocalStorage(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        store,
        getItem: key => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => void store.set(key, String(value)),
        removeItem: key => void store.delete(key),
        clear: () => store.clear(),
        get length() {
            return store.size;
        },
        key: index => Array.from(store.keys())[index] ?? null,
    };
}

// The script only parses GPX, so the XML stub understands exactly that: track
// points with lat/lon attributes, plus the parser-error probe.
class FakeXmlDocument extends FakeElement {
    constructor(text) {
        super('#xml', null);
        this.ownerDocument = this;
        if (!/<gpx[\s>]/i.test(text)) {
            const error = new FakeElement('parsererror', this);
            error.textContent = 'not a gpx document';
            this.append(error);
            return;
        }
        for (const match of text.matchAll(/<trkpt\b([^>]*)\/?>/gi)) {
            const point = new FakeElement('trkpt', this);
            for (const attribute of match[1].matchAll(/([a-z:]+)\s*=\s*"([^"]*)"/gi)) {
                point.setAttribute(attribute[1], attribute[2]);
            }
            this.append(point);
        }
    }
}

export class FakeDOMParser {
    parseFromString(text) {
        return new FakeXmlDocument(String(text));
    }
}

export class FakeMutationObserver {
    static instances = [];

    constructor(callback) {
        this.callback = callback;
        this.connected = false;
        FakeMutationObserver.instances.push(this);
    }

    observe() {
        this.connected = true;
    }

    disconnect() {
        this.connected = false;
    }

    // Test helper: pretend the page mutated.
    emit() {
        if (this.connected) this.callback([], this);
    }
}

// A Strava activity edit page with the name field the script fills in.
export function createEditPageDocument() {
    const document = new FakeDocument();
    const form = document.createElement('form');
    const label = document.createElement('label');
    label.setAttribute('for', 'activity_name');
    label.textContent = 'Title';
    const input = document.createElement('input');
    input.setAttribute('name', 'activity[name]');
    form.append(label, input);
    document.body.append(form);
    return { document, form, label, input };
}
