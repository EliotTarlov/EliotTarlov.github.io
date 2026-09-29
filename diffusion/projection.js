// Pressure projection: makes a grid velocity field divergence-free, so the fluid
// neither piles up nor thins out anywhere. It solves for the pressure that would
// cause the divergence, then subtracts that pressure's gradient.
//
// Velocity fields are fields (see createField) holding xy: velocity in cells/s,
// z: density. Density is only used when stiffness is set, in which case dense
// cells are made to flow outward and sparse ones inward, as if pressurized.
// Walls are solid: fluid can slide along them but not through them.

import { createProgram, createField, createDouble, pass } from './diffusion.js';

// GLSL shared by grid shaders
export const GRID_HEADER = `#version 300 es
precision highp float;
precision highp sampler2D;
out vec4 fragColor;
const ivec2 X = ivec2(1, 0), Y = ivec2(0, 1);

// a cell's value, with cells past the walls reading as the nearest wall cell
vec4 at(sampler2D s, ivec2 p) {
    return texelFetch(s, clamp(p, ivec2(0), textureSize(s, 0) - 1), 0);
}
`;

// r: the divergence the pressure has to cancel; walls reflect the flow into them
const DIVERGENCE_FS = GRID_HEADER + `
uniform sampler2D u_velocity;
uniform float u_stiffness;     // outflow per unit of density over u_restDensity, 1/s
uniform float u_restDensity;

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    ivec2 last = textureSize(u_velocity, 0) - 1;
    vec4 c = at(u_velocity, p);
    float l = p.x > 0      ? at(u_velocity, p - X).x : -c.x;
    float r = p.x < last.x ? at(u_velocity, p + X).x : -c.x;
    float b = p.y > 0      ? at(u_velocity, p - Y).y : -c.y;
    float t = p.y < last.y ? at(u_velocity, p + Y).y : -c.y;
    float wanted = u_stiffness * (c.z - u_restDensity);
    fragColor = vec4(0.5 * (r - l + t - b) - wanted, 0.0, 0.0, 1.0);
}`;

// one Jacobi iteration towards the pressure whose gradient cancels the divergence
const PRESSURE_FS = GRID_HEADER + `
uniform sampler2D u_pressure;
uniform sampler2D u_divergence;

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    float neighbors = at(u_pressure, p - X).r + at(u_pressure, p + X).r
                    + at(u_pressure, p - Y).r + at(u_pressure, p + Y).r;
    fragColor = vec4(0.25 * (neighbors - at(u_divergence, p).r), 0.0, 0.0, 1.0);
}`;

const GRADIENT_FS = GRID_HEADER + `
uniform sampler2D u_velocity;
uniform sampler2D u_pressure;

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec2 gradient = 0.5 * vec2(at(u_pressure, p + X).r - at(u_pressure, p - X).r,
                               at(u_pressure, p + Y).r - at(u_pressure, p - Y).r);
    vec4 v = at(u_velocity, p);
    fragColor = vec4(v.xy - gradient, v.z, 1.0);
}`;

// Returns project(velocity, stiffness, restDensity), which projects the
// velocity double (see createDouble) in place.
export function createProjection(gl, size, iterations = 20) {
    const divergenceProgram = createProgram(gl, DIVERGENCE_FS);
    const pressureProgram = createProgram(gl, PRESSURE_FS);
    const gradientProgram = createProgram(gl, GRADIENT_FS);
    const divergence = createField(gl, size);
    const pressure = createDouble(() => createField(gl, size)); // kept between calls as the solver's starting guess

    return function project(velocity, stiffness = 0, restDensity = 0) {
        pass(gl, divergenceProgram, divergence, { u_stiffness: stiffness, u_restDensity: restDensity },
            { u_velocity: velocity.read.texture });
        for (let i = 0; i < iterations; i++) {
            pass(gl, pressureProgram, pressure.write, {},
                { u_pressure: pressure.read.texture, u_divergence: divergence.texture });
            pressure.swap();
        }
        pass(gl, gradientProgram, velocity.write, {},
            { u_velocity: velocity.read.texture, u_pressure: pressure.read.texture });
        velocity.swap();
    };
}
