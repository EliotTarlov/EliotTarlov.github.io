/* <rough-box>: a block whose background is a hand-drawn rough.js squircle.

   Every attribute is passed to rough.js as an option, in kebab-case:
       <rough-box fill="#EEE" fill-style="solid" roughness="1.5">Hi</rough-box>
   Numbers are read as numbers, and an attribute with no value as true.
   See https://github.com/rough-stuff/rough/wiki#options for the options.

   The outline is drawn the way a person would draw it: one continuous line
   looping twice around, drifting a little between loops. The corners are
   rounded by the box's CSS border-radius (its top-left radius, for all four).

   The squircle is redrawn whenever the box resizes or an attribute changes,
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
        const w = this.offsetWidth, h = this.offsetHeight;
        const radius = parseFloat(getComputedStyle(this).borderTopLeftRadius) || 0;
        const options = this.options();
        const random = seededRandom(this.seed);
        const loop = squircle(w, h, radius);

        // start anywhere, go around twice and a bit, drifting in or out by up to `drift` pixels
        const first = Math.floor(random() * loop.length);
        const count = 2 * loop.length + 1 + Math.floor(random() * loop.length / 8);
        const drift = (random() < 0.5 ? -1 : 1) * 3 * (options.roughness ?? 1);
        const line = [];
        for (let i = 0; i < count; i++) {
            const [x, y] = loop[(first + i) % loop.length];
            const d = drift * i / count;
            line.push([x + d * Math.sign(x - w / 2), y + d * Math.sign(y - h / 2)]);
        }

        const canvas = rough.svg(this.svg);
        const fill = canvas.curve(loop, { ...options, stroke: 'none' });
        const stroke = canvas.curve(line, { ...options, fill: undefined, disableMultiStroke: true });
        this.svg.replaceChildren(fill, stroke);
    }
}

// Points once around a w x h rectangle whose corners curve in over `radius`
// pixels, for a smooth curve to be drawn through. Each corner is a cubic
// Bézier with its control points pulled toward the corner, which is flatter
// and squarer than a circular arc: a squircle.
function squircle(w, h, radius) {
    const r = Math.min(radius, w / 2, h / 2);
    const c = r * 0.1; // control points' distance from the corner; a circle would be r * 0.45
    const corners = [
        [[w - r, 0], [w - c, 0], [w, c], [w, r]],
        [[w, h - r], [w, h - c], [w - c, h], [w - r, h]],
        [[r, h], [c, h], [0, h - c], [0, h - r]],
        [[0, r], [0, c], [c, 0], [r, 0]],
    ];
    const points = [];
    corners.forEach(([p0, p1, p2, p3], i) => {
        const middle = [0, 1].map(k => (p0[k] + 3 * p1[k] + 3 * p2[k] + p3[k]) / 8); // the curve at t = 0.5
        points.push(p0, middle, p3);
        // then along the straight edge to the next corner
        const next = corners[(i + 1) % 4][0];
        const steps = Math.ceil(Math.hypot(next[0] - p3[0], next[1] - p3[1]) / 150);
        for (let j = 1; j < steps; j++) {
            points.push([p3[0] + (next[0] - p3[0]) * j / steps, p3[1] + (next[1] - p3[1]) * j / steps]);
        }
    });
    return points;
}

// a repeatable random number generator (mulberry32), so each redraw wobbles the same way
function seededRandom(seed) {
    return () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
    };
}

customElements.define('rough-box', RoughBox);
