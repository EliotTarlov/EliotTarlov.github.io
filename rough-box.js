/* <rough-box>: a block whose background is a hand-drawn rough.js rectangle.

   Every attribute is passed to rough.js as an option, in kebab-case:
       <rough-box fill="#EEE" fill-style="solid" roughness="1.5">Hi</rough-box>
   Numbers are read as numbers, and an attribute with no value as true.
   See https://github.com/rough-stuff/rough/wiki#options for the options.

   The rectangle is redrawn whenever the box resizes or an attribute changes,
   with the same seed each time so it doesn't jitter. Each box picks its own
   random seed unless given one.

   Needs rough.js loaded first, as the global `rough`. */

class RoughBox extends HTMLElement {
    connectedCallback() {
        if (this.shadowRoot) return; // moved in the DOM, already set up

        const shadow = this.attachShadow({ mode: 'open' });
        // isolation keeps the drawing's z-index of -1 inside the box, behind its content
        shadow.innerHTML = `
            <style>
                :host { display: block; position: relative; isolation: isolate; }
                svg { position: absolute; inset: 0; width: 100%; height: 100%;
                      z-index: -1; overflow: visible; pointer-events: none; }
            </style>
            <svg></svg>
            <slot></slot>`;
        this.svg = shadow.querySelector('svg');
        this.seed = 1 + Math.floor(Math.random() * 2 ** 31); // 0 would mean "no seed"

        new ResizeObserver(() => this.draw()).observe(this);
        new MutationObserver(() => this.draw()).observe(this, { attributes: true });
    }

    // the attributes as rough.js options, e.g. fill-style="solid" -> { fillStyle: 'solid' }
    options() {
        const options = { seed: this.seed };
        for (const { name, value } of this.attributes) {
            const key = name.replace(/-(\w)/g, (_, c) => c.toUpperCase());
            if (value === '') options[key] = true;
            else if (!isNaN(value)) options[key] = Number(value);
            else options[key] = value;
        }
        return options;
    }

    draw() {
        const shape = rough.svg(this.svg).rectangle(0, 0, this.offsetWidth, this.offsetHeight, this.options());
        this.svg.replaceChildren(shape);
    }
}

customElements.define('rough-box', RoughBox);
