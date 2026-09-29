// A display for the board that shows its density fluctuations at one scale.
//
// Each cell is drawn as mid-grey, lightened or darkened by how much denser or
// sparser it is at scales between smallSigma and largeSigma than at scales
// above largeSigma. That's measured in units of the fluctuation you'd expect
// from particles scattered at random, so it has the same contrast whatever the
// density. A little of each cell's own graininess is kept on top.
//
// The blobs it reveals are always there: particles scattered at random are
// denser in some patches than others, and those patches drift and morph as
// the particles diffuse, taking about sigma^2 steps to change at sigma cells.
//
// The grey can be Bayer dithered down to TONES tones. Keys:
//   D  cycles dithering: off, one threshold per board cell, one per screen pixel
//   B  switches the Bayer matrix between 4x4 and 8x8

import { OVERSCAN, CELL_SIZE, createProgram, pass } from './diffusion.js';
import { createDensityBlur } from './blur.js';

const DITHER_MODES = ['off', 'cell', 'pixel'];

const DRAW_FS = `#version 300 es
precision highp float;
precision highp usampler2D;
precision highp sampler2D;
uniform usampler2D u_current;
uniform usampler2D u_previous;
uniform sampler2D u_blurCurrent;
uniform sampler2D u_blurPrevious;
uniform sampler2D u_bias;
uniform float u_biasScale;
uniform float u_blend;         // 0 shows previous, 1 shows current
uniform bool u_showField;
uniform int u_overscan;        // board cells hidden past each edge of the canvas
uniform int u_cellSize;        // canvas pixels per board cell
uniform float u_smallSigma;
uniform int u_ditherMode;      // 0 off, 1 per board cell, 2 per screen pixel
uniform int u_bayerLevels;     // the Bayer matrix is 2^levels across: 2 for 4x4, 3 for 8x8
out vec4 fragColor;

const float PATTERN_GAIN = 0.15; // brightness per standard deviation of the blobs
const float GRAIN_GAIN = 0.05;   // brightness per standard deviation of a cell's own count
const float FIELD_GAIN = 8.0;    // how quickly the overlay brightens with bias strength
const float TONES = 3.0;         // distinct greys left after dithering
const vec3 DARK = vec3(0.0);     // the palette dithering blends between
const vec3 LIGHT = vec3(1.0);

vec3 hue(float angle) {
    return 0.5 + 0.5 * cos(angle + vec3(0.0, -2.0944, 2.0944));
}

// Bayer threshold in (0, 1) for position p. The 2x2 matrix [0 2; 3 1] gives
// each bit of p a digit; low bits of p make the high digits, so neighbouring
// thresholds are as far apart as possible.
float bayer(ivec2 p, int levels) {
    int v = 0;
    for (int i = 0; i < levels; i++) {
        int x = (p.x >> i) & 1, y = (p.y >> i) & 1;
        v = 4 * v + 2 * (x ^ y) + y;
    }
    return (float(v) + 0.5) / float(1 << (2 * levels));
}

void main() {
    // each board cell covers a u_cellSize square of canvas pixels
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    ivec2 size = textureSize(u_current, 0);
    ivec2 visible = size - 2 * u_overscan;
    ivec2 texel = min(pixel / u_cellSize, visible - 1) + u_overscan;

    float count = mix(float(texelFetch(u_previous, texel, 0).x),
                      float(texelFetch(u_current, texel, 0).x), u_blend);
    vec2 blurred = mix(texelFetch(u_blurPrevious, texel, 0).xy,
                       texelFetch(u_blurCurrent, texel, 0).xy, u_blend);
    float mean = max(blurred.y, 1.0);

    // randomly scattered particles vary by sqrt(mean) per cell, and blurring
    // with a Gaussian of sigma divides that by 2 sqrt(pi) sigma
    float blobNoise = sqrt(mean) / (3.5449 * u_smallSigma);
    float pattern = (blurred.x - blurred.y) / blobNoise;
    float grain = (count - blurred.y) / sqrt(mean);
    float grey = clamp(0.5 + PATTERN_GAIN * pattern + GRAIN_GAIN * grain, 0.0, 1.0);

    if (u_ditherMode != 0) {
        float threshold = bayer(u_ditherMode == 1 ? texel : pixel, u_bayerLevels);
        grey = min(floor(grey * (TONES - 1.0) + threshold), TONES - 1.0) / (TONES - 1.0);
    }
    vec3 color = mix(DARK, LIGHT, grey);

    if (u_showField) {
        vec2 bias = u_biasScale * textureLod(u_bias, (vec2(texel) + 0.5) / vec2(size), 0.0).xy;
        vec3 field = hue(atan(bias.y, bias.x)) * (1.0 - exp(-FIELD_GAIN * length(bias)));
        color = 0.35 * color + field;
    }
    fragColor = vec4(color, 1.0);
}`;

// Returns draw(blend, field, showField), to pass to run() in place of board.draw.
export function createBandpassDisplay(gl, board, smallSigma, largeSigma) {
    const program = createProgram(gl, DRAW_FS);
    const blur = createDensityBlur(gl, board, smallSigma, largeSigma);

    let ditherMode = 1;
    let bayerLevels = 2;
    window.addEventListener('keydown', e => {
        if (e.key === 'd') {
            ditherMode = (ditherMode + 1) % DITHER_MODES.length;
            console.log(`dithering: ${DITHER_MODES[ditherMode]}`);
        }
        if (e.key === 'b') {
            bayerLevels = bayerLevels === 2 ? 3 : 2;
            console.log(`bayer: ${1 << bayerLevels}x${1 << bayerLevels}`);
        }
    });

    return function draw(blend, field, showField) {
        blur.refresh();
        pass(gl, program, null, {
            u_blend: blend,
            u_biasScale: field.scale,
            u_showField: showField,
            u_overscan: OVERSCAN,
            u_cellSize: CELL_SIZE,
            u_smallSigma: smallSigma,
            u_ditherMode: ditherMode,
            u_bayerLevels: bayerLevels,
        }, {
            u_current: board.current,
            u_previous: board.previous,
            u_blurCurrent: blur.current,
            u_blurPrevious: blur.previous,
            u_bias: field.texture,
        });
    };
}
