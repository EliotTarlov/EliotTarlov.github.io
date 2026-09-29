// Particles diffusing on a walled board that fills the canvas.
//
// Every STEP_MS, each particle moves one cell up, down, left or right. Which way
// it goes is random, leaning along a bias field that the page supplies: a
// texture covering the whole board whose .xy, times a scale, is added to the
// log-odds of stepping +x/-x and +y/-y. The display fades between steps.
//
// A page makes a context, a board and a cursor, then calls run() with a
// function that returns the bias field for each display frame. Pressing F
// overlays that field: hue is direction, brightness is strength. The board's
// particle counts are readable too, for pages whose bias or display depends
// on them (see blur.js).
//
// The WebGL helpers (context, programs, targets, pass, drawPoints) and the
// cursor tracker don't depend on the board, and are shared with flip.html.

export const CELL_SIZE = 6; // screen pixels (physical, not CSS) per board cell, across and down
export const OVERSCAN = 64; // board cells hidden past each edge of the canvas, so the walls stay off-screen
export const STEP_MS = 100; // time between board steps; the display fades across it

const VERTEX_SHADER = `#version 300 es
in vec4 position;
void main() { gl_Position = position; }`;

// GLSL: uniform random floats in [0, 1), from a stream advanced by each call to rand
export const RANDOM_GLSL = `
uint hash(uint x) {
    x ^= x >> 16; x *= 0x7feb352du;
    x ^= x >> 15; x *= 0x846ca68bu;
    x ^= x >> 16;
    return x;
}

float rand(inout uint state) {
    state = hash(state);
    return float(state >> 8) * (1.0 / 16777216.0);
}`;

// GLSL: how strongly point p is covered by a soft stroke of the given radius from a to b, 0 to 1
export const STROKE_GLSL = `
float stroke(vec2 p, vec2 a, vec2 b, float radius) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    vec2 d = pa - ba * h;
    return exp(-dot(d, d) / (radius * radius));
}`;

// A WebGL2 context on a canvas that fills the window, one canvas pixel per
// physical screen pixel, so browser zoom and high-DPI screens don't resample it.
export function createContext(canvas) {
    const gl = canvas.getContext('webgl2');
    // fields are stored as half floats, which can only be rendered to with this
    if (!gl.getExtension('EXT_color_buffer_float')) console.error('EXT_color_buffer_float unavailable; fields will not render');

    function resize() {
        canvas.width = Math.round(window.innerWidth * window.devicePixelRatio);
        canvas.height = Math.round(window.innerHeight * window.devicePixelRatio);
    }
    window.addEventListener('resize', resize);
    resize();

    // Full-screen quad, drawn by every pass
    gl.bindVertexArray(gl.createVertexArray());
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    return gl;
}

// A program drawing with the given fragment shader; by default over the full-screen quad.
export function createProgram(gl, fsSource, vsSource = VERTEX_SHADER) {
    const prog = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vsSource], [gl.FRAGMENT_SHADER, fsSource]]) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        gl.attachShader(prog, shader);
    }
    gl.bindAttribLocation(prog, 0, 'position');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));

    // remembered so pass() knows how to set each uniform
    prog.uniformTypes = {};
    for (let i = 0; i < gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i++) {
        const info = gl.getActiveUniform(prog, i);
        prog.uniformTypes[info.name] = info.type;
    }
    return prog;
}

// A texture of the given size, with a framebuffer for drawing into it.
export function createTarget(gl, size, internalFormat, format, type, filter) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, size[0], size[1], 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return { texture, fbo, size };
}

// A target of four half floats per cell, smoothly interpolated when sampled between cells.
export function createField(gl, size) {
    return createTarget(gl, size, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
}

// Two targets to ping-pong between: draw into .write reading .read, then swap().
export function createDouble(create) {
    const double = {
        read: create(),
        write: create(),
        swap() { [double.read, double.write] = [double.write, double.read]; },
    };
    return double;
}

// Draws the full-screen quad with `program` into `target`, or the canvas when null.
// uniforms: { name: number | boolean | [x, y] }; textures: { samplerName: texture }
export function pass(gl, program, target, uniforms = {}, textures = {}) {
    use(gl, program, target, uniforms, textures);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

// Draws `count` points with `program` into `target`, adding onto what's there.
// The vertex shader places each point by gl_VertexID; there are no attributes.
export function drawPoints(gl, program, target, count, uniforms = {}, textures = {}) {
    use(gl, program, target, uniforms, textures);
    gl.disableVertexAttribArray(0); // the quad's buffer is too short to feed `count` vertices
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.disable(gl.BLEND);
    gl.enableVertexAttribArray(0);
}

// Sets `target`, or the canvas when null, to zero.
export function clear(gl, target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
}

// Readies `program` to draw into `target` with the given uniforms and textures.
function use(gl, program, target, uniforms, textures) {
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    const [width, height] = target ? target.size : [gl.canvas.width, gl.canvas.height];
    gl.viewport(0, 0, width, height);

    for (const [name, value] of Object.entries(uniforms)) {
        const loc = gl.getUniformLocation(program, name);
        switch (program.uniformTypes[name]) {
            case gl.FLOAT: gl.uniform1f(loc, value); break;
            case gl.FLOAT_VEC2: gl.uniform2fv(loc, value); break;
            case gl.INT: case gl.BOOL: gl.uniform1i(loc, value); break;
            case undefined: break; // unused, so compiled out of the shader
            default: throw new Error(`pass: can't set uniform ${name} of type ${program.uniformTypes[name]}`);
        }
    }
    Object.entries(textures).forEach(([name, texture], unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(gl.getUniformLocation(program, name), unit);
    });
}

// Runs at board resolution, once per step.
// Each texel holds a particle count. A fragment shader can't scatter particles
// to its neighbors, so each cell instead gathers: for each neighbor it
// recomputes how that neighbor split its particles among the four directions,
// and keeps the share pointed at itself. The split is seeded by (neighbor,
// step), so every cell that looks at a neighbor agrees on its split and no
// particles are lost. A particle that would step off the board stays put.
const STEP_FS = `#version 300 es
precision highp float;
precision highp usampler2D;
precision highp sampler2D;
uniform usampler2D u_counts;
uniform sampler2D u_bias;
uniform float u_biasScale;
uniform int u_step;
out uvec4 fragColor;

const uint EXACT_LIMIT = 64u;  // above this, binomials use a normal approximation
const ivec2 DIRS[4] = ivec2[4](ivec2(0, 1), ivec2(1, 0), ivec2(-1, 0), ivec2(0, -1));

bool inBounds(ivec2 p) {
    return all(greaterThanEqual(p, ivec2(0))) && all(lessThan(p, textureSize(u_counts, 0)));
}

uint count(ivec2 p) { return texelFetch(u_counts, p, 0).x; }
${RANDOM_GLSL}

// number of successes in n trials with probability p
uint binomial(uint n, float p, inout uint state) {
    if (n <= EXACT_LIMIT) {
        uint k = 0u;
        for (uint i = 0u; i < n; i++) {
            if (rand(state) < p) k++;
        }
        return k;
    }
    // Box-Muller normal sample
    float u1 = max(rand(state), 1e-7);
    float u2 = rand(state);
    float z = sqrt(-2.0 * log(u1)) * cos(6.28318530718 * u2);
    float mean = float(n) * p;
    float sd = sqrt(mean * (1.0 - p));
    return uint(clamp(round(mean + sd * z), 0.0, float(n)));
}

vec2 bias(ivec2 q) {
    vec2 uv = (vec2(q) + 0.5) / vec2(textureSize(u_counts, 0));
    return u_biasScale * textureLod(u_bias, uv, 0.0).xy;
}

// how many of cell q's particles step in each of the four DIRS
uvec4 split(ivec2 q) {
    vec2 lean = bias(q);

    // softmax over the four directions; subtracting the max keeps exp from overflowing
    vec4 logits;
    for (int k = 0; k < 4; k++) {
        logits[k] = dot(lean, vec2(DIRS[k]));
    }
    vec4 w = exp(logits - max(max(logits.x, logits.y), max(logits.z, logits.w)));
    w /= w.x + w.y + w.z + w.w;

    // multinomial as a chain of conditional binomials
    uint state = hash(uint(q.x) ^ hash(uint(q.y) ^ hash(uint(u_step))));
    uint remaining = count(q);
    float remainingP = 1.0;
    uvec4 s;
    for (int k = 0; k < 3; k++) {
        s[k] = binomial(remaining, clamp(w[k] / remainingP, 0.0, 1.0), state);
        remaining -= s[k];
        remainingP -= w[k];
    }
    s[3] = remaining;
    return s;
}

void main() {
    ivec2 px = ivec2(gl_FragCoord.xy);

    // particles stepping in from neighbors
    uint total = 0u;
    bool onEdge = false;
    for (int k = 0; k < 4; k++) {
        ivec2 q = px - DIRS[k];
        if (inBounds(q)) total += split(q)[k];
        if (!inBounds(px + DIRS[k])) onEdge = true;
    }

    // particles of our own that tried to step through a wall
    if (onEdge) {
        uvec4 own = split(px);
        for (int k = 0; k < 4; k++) {
            if (!inBounds(px + DIRS[k])) total += own[k];
        }
    }

    if (u_step < 1) {
        total = hash(uint(px.x) ^ hash(uint(px.y))) % 20u;
    }
    fragColor = uvec4(total, 0u, 0u, 1u);
}`;

// viewport: fades from the previous step to the current one, optionally overlaying the bias field
const DRAW_FS = `#version 300 es
precision highp float;
precision highp usampler2D;
precision highp sampler2D;
uniform usampler2D u_current;
uniform usampler2D u_previous;
uniform sampler2D u_bias;
uniform float u_biasScale;
uniform float u_blend;         // 0 shows previous, 1 shows current
uniform bool u_showField;
uniform int u_overscan;        // board cells hidden past each edge of the canvas
uniform int u_cellSize;        // canvas pixels per board cell
out vec4 fragColor;

const float WHITE_COUNT = 23.0;  // particle count drawn as full white
const float FIELD_GAIN = 8.0;    // how quickly the overlay brightens with bias strength

vec3 hue(float angle) {
    return 0.5 + 0.5 * cos(angle + vec3(0.0, -2.0944, 2.0944));
}

void main() {
    // each board cell covers a u_cellSize square of canvas pixels
    ivec2 size = textureSize(u_current, 0);
    ivec2 visible = size - 2 * u_overscan;
    ivec2 texel = min(ivec2(gl_FragCoord.xy) / u_cellSize, visible - 1) + u_overscan;

    float current = float(texelFetch(u_current, texel, 0).x);
    float previous = float(texelFetch(u_previous, texel, 0).x);
    vec3 color = vec3(min(mix(previous, current, u_blend) / WHITE_COUNT, 1.0));

    if (u_showField) {
        vec2 bias = u_biasScale * textureLod(u_bias, (vec2(texel) + 0.5) / vec2(size), 0.0).xy;
        vec3 field = hue(atan(bias.y, bias.x)) * (1.0 - exp(-FIELD_GAIN * length(bias)));
        color = 0.35 * color + field;
    }
    fragColor = vec4(color, 1.0);
}`;

// A board of CELL_SIZE cells covering the canvas, plus OVERSCAN on each side,
// fixed at the canvas's size when created.
export function createBoard(gl) {
    const size = [Math.ceil(gl.canvas.width / CELL_SIZE) + 2 * OVERSCAN,
                  Math.ceil(gl.canvas.height / CELL_SIZE) + 2 * OVERSCAN];
    const stepProgram = createProgram(gl, STEP_FS);
    const drawProgram = createProgram(gl, DRAW_FS);
    // .read holds the current step, .write the previous one
    const counts = createDouble(() => createTarget(gl, size, gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT, gl.NEAREST));
    let step = 0;

    return {
        size,

        // particle counts (unsigned integer textures) at the current and previous steps
        get current() { return counts.read.texture; },
        get previous() { return counts.write.texture; },
        // steps taken so far, so readers can tell when current has changed
        get steps() { return step; },

        // advances one step, leaning along the bias field
        step(field) {
            pass(gl, stepProgram, counts.write,
                { u_step: step, u_biasScale: field.scale },
                { u_counts: counts.read.texture, u_bias: field.texture });
            counts.swap();
            step++;
        },

        // draws to the canvas, blend of the way from the previous step to the current one
        draw(blend, field, showField) {
            pass(gl, drawProgram, null,
                { u_blend: blend, u_biasScale: field.scale, u_showField: showField, u_overscan: OVERSCAN,
                  u_cellSize: CELL_SIZE },
                { u_current: counts.read.texture, u_previous: counts.write.texture, u_bias: field.texture });
        },
    };
}

// The cursor's position in cells of a grid laid over the canvas, `cellSize`
// canvas pixels per cell, with `overscan` cells past each edge.
export function trackCursor(canvas, cellSize = CELL_SIZE, overscan = OVERSCAN) {
    let prev = null;
    const cursor = {
        pos: null, // null while the cursor is off the canvas

        // the segment moved along since the last call, [from, to], or null while off the canvas
        stroke() {
            const from = prev ?? cursor.pos;
            prev = cursor.pos;
            return cursor.pos && [from, cursor.pos];
        },
    };
    canvas.addEventListener('pointermove', e => {
        // CSS pixels to canvas pixels, with y flipped to count up from the bottom like GL
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) * canvas.width / rect.width;
        const y = (rect.bottom - e.clientY) * canvas.height / rect.height;
        cursor.pos = [overscan + x / cellSize, overscan + y / cellSize];
    });
    canvas.addEventListener('pointerleave', () => cursor.pos = null);
    return cursor;
}

// Runs the page forever. update(dt) is called every display frame with the
// seconds since the last, and returns the bias field: { texture, scale }.
// draw(blend, field, showField) draws the board; by default board.draw.
export function run(board, update, draw = board.draw) {
    let showField = false;
    window.addEventListener('keydown', e => {
        if (e.key === 'f') showField = !showField;
    });

    let lastFrameTime = null;
    let lastStepTime = -Infinity;
    function render(now) {
        const dt = Math.max((now - (lastFrameTime ?? now)) / 1000, 1e-3);
        lastFrameTime = now;
        const field = update(dt);

        if (now - lastStepTime >= STEP_MS) {
            board.step(field);
            lastStepTime = now; // not += STEP_MS, so a backgrounded tab doesn't burst on return
        }
        draw(Math.min((now - lastStepTime) / STEP_MS, 1), field, showField);
        requestAnimationFrame(render);
    }
    requestAnimationFrame(render);
}
