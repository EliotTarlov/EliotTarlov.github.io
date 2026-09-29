// The board's particle density, blurred at two scales: a field whose
// x is the density blurred with a Gaussian of smallSigma cells, and
// y is the density blurred with a Gaussian of largeSigma cells.
// Their difference picks out features between the two scales.
//
// Blurring is costly at large sigmas, so it happens once per board step:
// call refresh() as often as you like and it only works when the board has
// moved on. The blurs of the current and previous steps are kept, so a
// display can fade between them like the board's own does.

import { createProgram, createField, createDouble, pass } from './diffusion.js';

// Gaussian weights for the two sigmas at an offset of i cells
const WEIGHTS_GLSL = `
uniform float u_smallSigma;
uniform float u_largeSigma;

vec2 weights(int i) {
    vec2 sigma = vec2(u_smallSigma, u_largeSigma);
    return exp(-float(i * i) / (2.0 * sigma * sigma));
}`;

// blurs the counts along x, both sigmas at once
const HORIZONTAL_FS = `#version 300 es
precision highp float;
precision highp usampler2D;
uniform usampler2D u_counts;
out vec4 fragColor;
${WEIGHTS_GLSL}

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    int last = textureSize(u_counts, 0).x - 1;
    int reach = int(ceil(3.0 * u_largeSigma));
    vec2 sum = vec2(0.0), total = vec2(0.0);
    for (int i = -reach; i <= reach; i++) {
        float count = float(texelFetch(u_counts, ivec2(clamp(p.x + i, 0, last), p.y), 0).x);
        vec2 w = weights(i);
        sum += w * count;
        total += w;
    }
    fragColor = vec4(sum / total, 0.0, 1.0);
}`;

// blurs the horizontal pass along y: x with the small sigma, y with the large
const VERTICAL_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_horizontal;
out vec4 fragColor;
${WEIGHTS_GLSL}

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    int last = textureSize(u_horizontal, 0).y - 1;
    int reach = int(ceil(3.0 * u_largeSigma));
    vec2 sum = vec2(0.0), total = vec2(0.0);
    for (int i = -reach; i <= reach; i++) {
        vec2 value = texelFetch(u_horizontal, ivec2(p.x, clamp(p.y + i, 0, last)), 0).xy;
        vec2 w = weights(i);
        sum += w * value;
        total += w;
    }
    fragColor = vec4(sum / total, 0.0, 1.0);
}`;

export function createDensityBlur(gl, board, smallSigma, largeSigma) {
    const horizontalProgram = createProgram(gl, HORIZONTAL_FS);
    const verticalProgram = createProgram(gl, VERTICAL_FS);
    const horizontal = createField(gl, board.size);
    // .read holds the current step's blur, .write the previous one's
    const blurred = createDouble(() => createField(gl, board.size));
    const sigmas = { u_smallSigma: smallSigma, u_largeSigma: largeSigma };
    let blurredStep = null;

    return {
        smallSigma,
        largeSigma,
        get current() { return blurred.read.texture; },
        get previous() { return blurred.write.texture; },

        refresh() {
            if (board.steps === blurredStep) return;
            pass(gl, horizontalProgram, horizontal, sigmas, { u_counts: board.current });
            pass(gl, verticalProgram, blurred.write, sigmas, { u_horizontal: horizontal.texture });
            blurred.swap();
            blurredStep = board.steps;
        },
    };
}
