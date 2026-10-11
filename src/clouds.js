import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

// Volumetric clouds: a slab of cumulus high above the island, ray-marched every frame.
//
// - Noise is baked once on the GPU into tileable textures: a 3D Perlin-Worley volume for
//   the big billowing shapes, a finer 3D Worley volume that erodes their edges, and a 2D
//   domain-warped weather map that says where clouds form and how tall they grow
// - Each frame a full-screen pass marches every view ray through the slab at a fraction
//   of the screen resolution, lighting each sample with a short march toward the sun
//   (self-shadowing), a two-lobe phase function (bright forward scattering, i.e. silver
//   linings) and an approximation of multiple scattering for soft, luminous interiors
// - The ray start is jittered a little differently each frame and blended with the
//   previous frame, reprojected to where each cloud was on screen, so few steps still give
//   a smooth, stable result
// - The output (light scattered toward the camera in rgb, transmittance in alpha) is read
//   by the sky dome, which draws behind everything: scene geometry is always nearer than
//   the clouds, so the depth test alone composites them correctly

// Quality presets: resolution is a fraction of the canvas size in CSS pixels (so a
// high-DPI screen doesn't quadruple the cost); history is how much of the previous frame
// each pixel keeps. Measured cost of the cloud pass at 1920x1080 on a laptop RTX 3050:
// low 0.7 ms, medium 1.7 ms, high 2.5 ms, ultra (full resolution) 10.8 ms
export const cloudQualityPresets = {
  low: { resolution: 0.35, steps: 32, lightSteps: 3, history: 0.92 },
  medium: { resolution: 0.5, steps: 48, lightSteps: 5, history: 0.9 },
  high: { resolution: 0.5, steps: 80, lightSteps: 6, history: 0.88 },
  ultra: { resolution: 1, steps: 112, lightSteps: 7, history: 0.85 },
}

// Shared GLSL for baking: a hash without sine (stable on every GPU), and periodic gradient
// and Worley noise, so every baked texture tiles seamlessly in all directions
const tileableNoise = /* glsl */ `
  vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }

  float gradientCorner(vec3 cell, vec3 corner, vec3 local, float period) {
    vec3 gradient = normalize(hash33(mod(cell + corner, period)) * 2.0 - 1.0 + 1e-4);
    return dot(gradient, local - corner);
  }

  // Gradient noise in about [-1, 1], repeating every \`period\` units
  float gradientNoise(vec3 x, float period) {
    vec3 cell = floor(x);
    vec3 local = fract(x);
    vec3 u = local * local * local * (local * (local * 6.0 - 15.0) + 10.0);
    return mix(
      mix(
        mix(gradientCorner(cell, vec3(0, 0, 0), local, period), gradientCorner(cell, vec3(1, 0, 0), local, period), u.x),
        mix(gradientCorner(cell, vec3(0, 1, 0), local, period), gradientCorner(cell, vec3(1, 1, 0), local, period), u.x),
        u.y
      ),
      mix(
        mix(gradientCorner(cell, vec3(0, 0, 1), local, period), gradientCorner(cell, vec3(1, 0, 1), local, period), u.x),
        mix(gradientCorner(cell, vec3(0, 1, 1), local, period), gradientCorner(cell, vec3(1, 1, 1), local, period), u.x),
        u.y
      ),
      u.z
    );
  }

  float perlinFbm(vec3 uvw, float frequency, int octaves) {
    float value = 0.0;
    float amplitude = 1.0;
    float total = 0.0;
    for (int i = 0; i < 8; i++) {
      if (i >= octaves) break;
      value += gradientNoise(uvw * frequency, frequency) * amplitude;
      total += amplitude;
      frequency *= 2.0;
      amplitude *= 0.5;
    }
    return value / total;
  }

  // Inverted cellular noise: 1 at each feature point, falling off between them
  float worley(vec3 uvw, float frequency) {
    vec3 x = uvw * frequency;
    vec3 cell = floor(x);
    vec3 local = fract(x);
    float nearest = 1.0;
    for (int z = -1; z <= 1; z++)
    for (int y = -1; y <= 1; y++)
    for (int i = -1; i <= 1; i++) {
      vec3 offset = vec3(float(i), float(y), float(z));
      vec3 delta = hash33(mod(cell + offset, frequency)) + offset - local;
      nearest = min(nearest, length(delta));
    }
    return 1.0 - nearest;
  }

  float worleyFbm(vec3 uvw, float frequency) {
    return worley(uvw, frequency) * 0.625 + worley(uvw, frequency * 2.0) * 0.25 + worley(uvw, frequency * 4.0) * 0.125;
  }

  float remap(float value, float low, float high, float newLow, float newHigh) {
    return newLow + (value - low) / (high - low) * (newHigh - newLow);
  }
`

const quadVertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

// Shape volume. r: billowy Perlin-Worley, the base of every cloud. gba: Worley fbm at
// three increasing frequencies, used to carve the base shape into separate puffs
const shapeBakeShader = /* glsl */ `
  uniform float uSlice;
  varying vec2 vUv;
  ${tileableNoise}

  void main() {
    vec3 uvw = vec3(vUv, uSlice);
    float perlin = clamp(abs(perlinFbm(uvw, 4.0, 7) * 2.2), 0.0, 1.0);
    float g = worleyFbm(uvw, 4.0);
    float b = worleyFbm(uvw, 8.0);
    float a = worleyFbm(uvw, 16.0);
    float perlinWorley = remap(perlin, 0.0, 1.0, g, 1.0);
    gl_FragColor = vec4(clamp(perlinWorley, 0.0, 1.0), g, b, a);
  }
`

// Detail volume: Worley fbm at three frequencies, for the small cauliflower bumps and
// wisps along the edges
const detailBakeShader = /* glsl */ `
  uniform float uSlice;
  varying vec2 vUv;
  ${tileableNoise}

  void main() {
    vec3 uvw = vec3(vUv, uSlice);
    gl_FragColor = vec4(worleyFbm(uvw, 2.0), worleyFbm(uvw, 4.0), worleyFbm(uvw, 8.0), 1.0);
  }
`

// Weather map, 2D. r: where clouds form, as round cumulus cells (Worley) grouped into
// drifting clusters (Perlin), both domain-warped by a third noise so the cells come out
// stretched and irregular instead of evenly spaced. g: how tall the clouds there grow
const weatherBakeShader = /* glsl */ `
  varying vec2 vUv;
  ${tileableNoise}

  void main() {
    vec3 uvw = vec3(vUv, 0.0);
    vec2 warp = vec2(perlinFbm(uvw + vec3(0.0, 0.0, 0.25), 3.0, 4), perlinFbm(uvw + vec3(0.0, 0.0, 0.6), 3.0, 4));
    vec3 warped = vec3(vUv + warp * 0.09, 0.0);
    float clusters = perlinFbm(warped, 4.0, 5) * 0.5 + 0.5;
    float cells = worleyFbm(warped + vec3(0.0, 0.0, 0.4), 9.0);
    // Both stretched to fill roughly 0-1 (measured: the raw sums only span a narrow band)
    float coverage = clamp((clusters * 0.75 + cells * 0.7 - 0.55) / 0.33, 0.0, 1.0);
    float height = perlinFbm(uvw + vec3(0.0, 0.0, 0.8), 3.0, 3) * 0.5 + 0.5;
    gl_FragColor = vec4(coverage, clamp((height - 0.36) / 0.24, 0.0, 1.0), 0.0, 1.0);
  }
`

const setTiling = (texture) => {
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.wrapR = THREE.RepeatWrapping
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
}

// Renders a bake shader into every slice of a size^3 volume
const bakeVolume = (renderer, size, fragmentShader) => {
  const target = new THREE.WebGL3DRenderTarget(size, size, size, { depthBuffer: false })
  setTiling(target.texture)
  const material = new THREE.ShaderMaterial({ uniforms: { uSlice: { value: 0 } }, vertexShader: quadVertexShader, fragmentShader })
  const quad = new FullScreenQuad(material)
  for (let layer = 0; layer < size; layer++) {
    material.uniforms.uSlice.value = (layer + 0.5) / size
    renderer.setRenderTarget(target, layer)
    quad.render(renderer)
  }
  quad.dispose()
  material.dispose()
  return target
}

const bakeWeather = (renderer, size) => {
  const target = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false })
  setTiling(target.texture)
  const material = new THREE.ShaderMaterial({ vertexShader: quadVertexShader, fragmentShader: weatherBakeShader })
  const quad = new FullScreenQuad(material)
  renderer.setRenderTarget(target)
  quad.render(renderer)
  quad.dispose()
  material.dispose()
  return target
}

// Density field and lighting, shared by the view pass and the sun-visibility probe
const cloudFieldShader = /* glsl */ `
  uniform sampler3D uShapeNoise;
  uniform sampler3D uDetailNoise;
  uniform sampler2D uWeatherMap;
  uniform vec3 uWindOffset;
  uniform float uEvolve;
  uniform float uCoverage;
  uniform float uClustering;
  uniform float uSunClearing;
  uniform float uDensity;
  uniform float uScale;
  uniform float uBase;
  uniform float uThickness;
  uniform float uDetail;
  uniform float uMaxDistance;
  uniform vec3 uSunDirection;
  uniform int uLightSteps;

  // Extinction per world unit at density 1
  const float EXTINCTION = 0.09;

  float saturate(float x) {
    return clamp(x, 0.0, 1.0);
  }

  float remap(float value, float low, float high, float newLow, float newHigh) {
    return newLow + (value - low) / (high - low) * (newHigh - newLow);
  }

  // Coverage (x) and cloud height (y) at a ground position. Two layers of the same map at
  // unrelated scales, angles and speeds: their sum never repeats, and as one slides over
  // the other, clouds slowly grow, merge and dissolve instead of just translating
  vec2 weatherAt(vec2 xz) {
    float tile = 4200.0 * uScale;
    vec2 p = xz - uWindOffset.xz;
    vec4 a = textureLod(uWeatherMap, p / tile, 0.0);
    vec2 q = mat2(0.8, -0.6, 0.6, 0.8) * (p + vec2(uEvolve * 3.1, uEvolve * -1.7)) / (tile * 0.618) + 0.37;
    vec4 b = textureLod(uWeatherMap, q, 0.0);
    return vec2(a.r + (b.r - 0.5) * 0.45, mix(a.g, b.g, 0.4));
  }

  // Base cloud density (no fine detail), with the height within the slab (0 = cloud base,
  // 1 = top) returned in \`height\`
  float baseDensity(vec3 p, out float height) {
    height = (p.y - uBase) / uThickness;
    if (height < 0.0 || height > 1.0) return 0.0;

    // Cloud regions: a much larger, smooth pattern (the weather map's height channel at a
    // third of its usual frequency, turned and offset) decides where clouds may form at
    // all, so they come in scattered groups with wide stretches of open sky between them
    // instead of an even spread. uClustering 0 turns this off
    vec2 regionPosition = mat2(0.6, 0.8, -0.8, 0.6) * (p.xz - uWindOffset.xz) / (13000.0 * uScale) + vec2(0.21, 0.67);
    float region = smoothstep(0.42, 0.72, textureLod(uWeatherMap, regionPosition, 0.0).g);
    float localCoverage = uCoverage * mix(1.0, region, uClustering);
    // Open sky around the sun: seen from the island, no clouds form within uSunClearing
    // (an angle, in radians) of the sun, and they come back gradually over more than as
    // much again, so the sun and its rays sit in clear sky with clouds kept at a distance
    float fromSun = acos(clamp(dot(normalize(p), uSunDirection), -1.0, 1.0));
    localCoverage *= smoothstep(uSunClearing, uSunClearing * 2.4, fromSun);
    if (localCoverage <= 0.0) return 0.0;

    vec2 weather = weatherAt(p.xz);
    float coverage = saturate(remap(weather.x, 1.0 - localCoverage, 1.0 - localCoverage + 0.3, 0.0, 1.0));
    if (coverage <= 0.0) return 0.0;

    // Cumulus profile: a fairly flat base, then rounded tops. Thin coverage near a cloud's
    // edge also lowers its top, which domes each cloud over its footprint
    // (Never too low: a thin sheet at the base would show as streaks seen edge-on)
    float top = mix(0.55, 1.0, weather.y) * (0.6 + 0.4 * coverage);
    float profile = smoothstep(0.0, 0.1, height) * (1.0 - smoothstep(top * 0.5, top, height));
    if (profile <= 0.0) return 0.0;

    // Domain warp: the weather map nudges the shape lookup, so the same billows never line
    // up twice. The slow vertical drift (uEvolve) makes the billows churn as they travel
    vec3 shapePosition = p - uWindOffset + vec3(weather.y * 160.0, uEvolve, weather.x * 120.0);
    vec4 shape = textureLod(uShapeNoise, shapePosition / (1700.0 * uScale), 0.0);
    float lowFbm = dot(shape.gba, vec3(0.625, 0.25, 0.125));
    // Perlin-Worley eroded by the Worley fbm, then stretched to fill 0-1
    float base = saturate((remap(shape.r, lowFbm - 1.0, 1.0, 0.0, 1.0) - 0.6) / 0.27);
    // Even where coverage is full, the threshold stays above zero, so the 3D noise always
    // carves the cloud into rounded billows rather than a smooth mass; thinner coverage
    // leaves only the strongest billows, as separate puffs
    float threshold = mix(1.0, 0.22, coverage);
    return saturate(remap(base * profile, threshold, 1.0, 0.0, 1.0));
  }

  // Erodes the base density with the detail noise: wispy at the bottom, billowy on top
  float detailDensity(float density, vec3 p, float height) {
    vec3 detailPosition = p - uWindOffset * 1.15 + vec3(0.0, uEvolve * 2.0, 0.0);
    vec3 detail = textureLod(uDetailNoise, detailPosition / (300.0 * uScale), 0.0).rgb;
    float detailFbm = saturate((dot(detail, vec3(0.625, 0.25, 0.125)) - 0.35) / 0.35);
    float modifier = mix(detailFbm, 1.0 - detailFbm, saturate(height * 4.0));
    return saturate(remap(density, modifier * 0.5 * uDetail, 1.0, 0.0, 1.0));
  }

  // Optical depth toward the sun: a few steps, each longer than the last, through the
  // base density. This is what shades a cloud's interior and the side away from the sun
  float sunOpticalDepth(vec3 p) {
    float depth = 0.0;
    float stepLength = uThickness * 0.05;
    float height;
    for (int i = 0; i < 16; i++) {
      if (i >= uLightSteps) break;
      p += uSunDirection * stepLength;
      depth += baseDensity(p - uSunDirection * stepLength * 0.5, height) * stepLength;
      stepLength *= 1.65;
    }
    return depth * EXTINCTION * uDensity;
  }

  // Distance along a ray where it enters and leaves the slab, clipped to uMaxDistance
  bool slabRange(vec3 origin, vec3 direction, out float near, out float far) {
    float top = uBase + uThickness;
    if (abs(direction.y) < 1e-5) {
      near = 0.0;
      far = uMaxDistance;
      return origin.y > uBase && origin.y < top;
    }
    float toBase = (uBase - origin.y) / direction.y;
    float toTop = (top - origin.y) / direction.y;
    near = max(min(toBase, toTop), 0.0);
    far = min(max(toBase, toTop), uMaxDistance);
    return far > near;
  }
`

const cloudMarchShader = /* glsl */ `
  uniform sampler2D uHistory;
  uniform mat4 uInverseProjection;
  uniform mat4 uCameraWorld;
  uniform mat4 uPreviousViewProjection;
  uniform vec3 uCameraPosition;
  uniform float uFrame;
  uniform float uHistoryWeight;
  uniform int uSteps;
  uniform vec3 uSunColor;
  uniform vec3 uSkyTop;
  uniform vec3 uSkyHorizon;
  uniform float uSunLight;
  uniform float uAmbientLight;
  uniform float uSkyLight;
  uniform float uShadow;
  uniform float uSilverLining;
  varying vec2 vUv;
  ${cloudFieldShader}

  // Henyey-Greenstein phase, scaled so that isotropic scattering is 1
  float henyeyGreenstein(float cosTheta, float g) {
    float g2 = g * g;
    return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
  }

  // Mostly forward scattering (light glowing through cloud edges toward the sun), a little
  // back scattering, and a tight extra lobe for the silver lining right around the sun
  float phase(float cosTheta, float spread) {
    float body = mix(henyeyGreenstein(cosTheta, -0.15 * spread), henyeyGreenstein(cosTheta, 0.65 * spread), 0.6);
    return body + uSilverLining * 0.12 * henyeyGreenstein(cosTheta, 0.9 * spread);
  }

  // Per-pixel offset in [0, 1) with an even, noise-like spread (interleaved gradient noise)
  float interleavedNoise(vec2 pixel) {
    return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
  }

  void main() {
    vec4 viewPosition = uInverseProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 direction = normalize((uCameraWorld * vec4(viewPosition.xyz / viewPosition.w, 0.0)).xyz);
    vec3 origin = uCameraPosition;

    vec3 scattered = vec3(0.0);
    float transmittance = 1.0;
    // Where along the ray the visible cloud is, on average, for reprojection
    float depthSum = 0.0;
    float depthWeight = 0.0;
    float near, far;
    bool hit = slabRange(origin, direction, near, far);

    if (hit) {
      // Adaptive steps: inside cloud, the step grows with distance (a far cloud covers fewer
      // pixels, so it needs fewer samples), never finer than the slab needs overhead. Clear
      // air is crossed in steps 2.5 times longer
      float minStep = uThickness / float(uSteps) * 1.5;
      float growth = 0.6 / float(uSteps);
      // Shifting the noise pattern each frame (rather than offsetting the same pattern)
      // lets the temporal blend average it out evenly, with no leftover streaks
      float jitter = interleavedNoise(gl_FragCoord.xy + 5.588238 * uFrame);
      float t = near + max(minStep, near * growth) * jitter;

      float cosTheta = dot(direction, uSunDirection);
      // Phase for each multiple-scattering octave: each bounce spreads the light more
      float phase0 = phase(cosTheta, 1.0);
      float phase1 = phase(cosTheta, 0.5);
      float phase2 = phase(cosTheta, 0.25);
      vec3 sunLight = uSunColor * uSunLight;
      // Ambient sky light: the sky's colors, partly desaturated, brighter toward cloud tops
      vec3 skyLight = mix(uSkyHorizon, vec3(dot(uSkyHorizon, vec3(0.2126, 0.7152, 0.0722))), 0.35);
      vec3 zenithLight = mix(uSkyTop, vec3(dot(uSkyTop, vec3(0.2126, 0.7152, 0.0722))), 0.25);
      // Dark-edge ("powder") effect: shows when the sun is behind the viewer
      float powderAmount = 0.75 * saturate(0.5 - 0.5 * cosTheta);
      vec3 hazeColor = uSkyHorizon * 1.05;

      bool inClearAir = false;
      int fineSteps = 0;
      for (int i = 0; i < 512; i++) {
        // Early exit once the cloud in front is effectively opaque
        if (i >= uSteps * 3 || t > far || transmittance < 0.01) break;
        float stepLength = max(minStep, t * growth);
        vec3 p = origin + direction * t;
        float height;
        float density = baseDensity(p, height);

        if (density <= 0.0) {
          // Short steps for a few samples after backing up (see below), long ones otherwise
          t += stepLength * (fineSteps > 0 ? 1.0 : 2.5);
          inClearAir = fineSteps <= 0;
          fineSteps--;
          continue;
        }
        if (inClearAir) {
          // Just entered a cloud with a long step: back up and come in with short steps,
          // so the cloud's edge isn't placed by where the long step happened to land
          inClearAir = false;
          fineSteps = 3;
          t = max(t - stepLength * 2.0, near);
          continue;
        }

        density = detailDensity(density, p, height);
        // Clouds thin out toward the far limit instead of ending at a hard line
        density *= 1.0 - smoothstep(uMaxDistance * 0.55, uMaxDistance, t);

        if (density > 0.0) {
          float extinction = density * EXTINCTION * uDensity;
          float lightDepth = sunOpticalDepth(p) * uShadow;
          // Multiple scattering, approximated by a few octaves of single scattering with
          // weaker extinction and wider phase each time (Wrenninge et al.)
          float sun = phase0 * exp(-lightDepth) + 0.5 * phase1 * exp(-lightDepth * 0.5) + 0.25 * phase2 * exp(-lightDepth * 0.25);
          float powder = mix(1.0, 1.0 - exp(-extinction * 220.0), powderAmount);
          vec3 ambient = mix(skyLight * 0.55, zenithLight * 1.1, pow(height, 0.7)) * uAmbientLight * uSkyLight;
          vec3 radiance = sunLight * sun * powder + ambient;
          // Aerial perspective: distant clouds take on the color of the haze
          radiance = mix(radiance, hazeColor, (1.0 - exp(-t / (uMaxDistance * 0.4))) * 0.8);

          // Energy-conserving integration over the step (albedo 1: scattering = extinction)
          float stepTransmittance = exp(-extinction * stepLength);
          float absorbed = transmittance * (1.0 - stepTransmittance);
          scattered += radiance * absorbed;
          depthSum += t * absorbed;
          depthWeight += absorbed;
          transmittance *= stepTransmittance;
        }
        t += stepLength;
      }

      // Treat the last 1% as fully opaque, so early exit doesn't leave faint holes
      if (transmittance < 0.01) {
        scattered /= 1.0 - transmittance;
        transmittance = 0.0;
      }
    }

    vec4 current = vec4(scattered, transmittance);

    // Temporal blend: find where this cloud was on screen last frame and mix in what was
    // computed there. Rays that see no cloud reproject from the middle of the slab
    float depth = depthWeight > 1e-3 ? depthSum / depthWeight : (hit ? 0.5 * (near + far) : 1e4);
    vec4 previousClip = uPreviousViewProjection * vec4(origin + direction * depth, 1.0);
    vec2 previousUv = previousClip.xy / previousClip.w * 0.5 + 0.5;
    bool onScreen = previousClip.w > 0.0 && all(greaterThanEqual(previousUv, vec2(0.0))) && all(lessThanEqual(previousUv, vec2(1.0)));
    float historyWeight = onScreen ? uHistoryWeight : 0.0;
    gl_FragColor = mix(current, texture2D(uHistory, previousUv), historyWeight);
  }
`

// One pixel: how much sunlight reaches the middle of the island through the clouds. Read
// back asynchronously a few times a second to dim the sun as clouds pass in front of it
const sunVisibilityShader = /* glsl */ `
  varying vec2 vUv;
  ${cloudFieldShader}

  void main() {
    vec3 origin = vec3(0.0, 1.0, 0.0);
    float transmittance = 1.0;
    float near, far;
    if (uSunDirection.y > 0.0 && slabRange(origin, uSunDirection, near, far)) {
      float stepLength = (far - near) / 48.0;
      for (int i = 0; i < 48; i++) {
        vec3 p = origin + uSunDirection * (near + stepLength * (float(i) + 0.5));
        float height;
        float density = baseDensity(p, height);
        if (density > 0.0) density = detailDensity(density, p, height);
        transmittance *= exp(-density * EXTINCTION * uDensity * stepLength);
      }
    }
    gl_FragColor = vec4(vec3(transmittance), 1.0);
  }
`

export const createVolumetricClouds = (renderer, quality = 'medium') => {
  const previousTarget = renderer.getRenderTarget()
  const shapeNoise = bakeVolume(renderer, 128, shapeBakeShader)
  const detailNoise = bakeVolume(renderer, 64, detailBakeShader)
  const weatherMap = bakeWeather(renderer, 512)
  renderer.setRenderTarget(previousTarget)

  // Shared by reference between both passes; the scene's animation loop eases the
  // settings (coverage, density, lighting...) and sets the sun and sky every frame
  const uniforms = {
    uShapeNoise: { value: shapeNoise.texture },
    uDetailNoise: { value: detailNoise.texture },
    uWeatherMap: { value: weatherMap.texture },
    uHistory: { value: null },
    uInverseProjection: { value: new THREE.Matrix4() },
    uCameraWorld: { value: new THREE.Matrix4() },
    uPreviousViewProjection: { value: new THREE.Matrix4() },
    uCameraPosition: { value: new THREE.Vector3() },
    uFrame: { value: 0 },
    uHistoryWeight: { value: 0 },
    uSteps: { value: 48 },
    uLightSteps: { value: 5 },
    uWindOffset: { value: new THREE.Vector3() },
    uEvolve: { value: 0 },
    uCoverage: { value: 0.5 },
    // How strongly clouds group into scattered patches with open sky between (0 = even)
    uClustering: { value: 1 },
    // Radius of the clear sky kept around the sun, in radians (0 = clouds right up to it)
    uSunClearing: { value: THREE.MathUtils.degToRad(10) },
    uDensity: { value: 1 },
    uScale: { value: 1 },
    uBase: { value: 220 },
    uThickness: { value: 180 },
    uDetail: { value: 1 },
    uMaxDistance: { value: 7000 },
    uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color('#ffffff') },
    uSkyTop: { value: new THREE.Color() },
    uSkyHorizon: { value: new THREE.Color() },
    uSunLight: { value: 1 },
    uAmbientLight: { value: 1 },
    // Scene-driven: how bright the sky light is (ambient light, sun height)
    uSkyLight: { value: 1 },
    uShadow: { value: 1 },
    uSilverLining: { value: 1 },
  }

  const marchMaterial = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: quadVertexShader,
    fragmentShader: cloudMarchShader,
    depthTest: false,
    depthWrite: false,
  })
  const marchQuad = new FullScreenQuad(marchMaterial)

  const sunMaterial = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: quadVertexShader,
    fragmentShader: sunVisibilityShader,
    depthTest: false,
    depthWrite: false,
  })
  const sunQuad = new FullScreenQuad(sunMaterial)
  const sunTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false })
  const sunPixel = new Uint8Array(4)
  const sunProbe = { pending: false, wait: 0 }

  // Two half-float targets, swapped every frame: one is written, the other is the history
  let targets = []
  let current = 0
  let historyValid = false
  let preset = cloudQualityPresets[quality] || cloudQualityPresets.medium
  const cssSize = new THREE.Vector2(1, 1)
  const previousViewProjection = new THREE.Matrix4()

  const state = {
    uniforms,
    // Fraction of direct sunlight reaching the island (1 = clear sky), updated a few
    // times a second
    sunVisibility: 1,
    get texture() {
      return targets[current].texture
    },
  }

  const buildTargets = () => {
    targets.forEach((target) => target.dispose())
    const width = Math.max(1, Math.round(cssSize.x * preset.resolution))
    const height = Math.max(1, Math.round(cssSize.y * preset.resolution))
    targets = [0, 1].map(
      () =>
        new THREE.WebGLRenderTarget(width, height, {
          type: THREE.HalfFloatType,
          depthBuffer: false,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
        })
    )
    historyValid = false
  }

  state.setSize = (width, height) => {
    cssSize.set(width, height)
    buildTargets()
  }

  state.setQuality = (name) => {
    preset = cloudQualityPresets[name] || cloudQualityPresets.medium
    uniforms.uSteps.value = preset.steps
    uniforms.uLightSteps.value = preset.lightSteps
    buildTargets()
  }
  state.setQuality(quality)

  // Marches this frame's clouds into the next target. Call after the camera has moved
  state.render = (camera, delta) => {
    camera.updateMatrixWorld()
    uniforms.uInverseProjection.value.copy(camera.projectionMatrixInverse)
    uniforms.uCameraWorld.value.copy(camera.matrixWorld)
    uniforms.uCameraPosition.value.setFromMatrixPosition(camera.matrixWorld)
    uniforms.uPreviousViewProjection.value.copy(previousViewProjection)
    uniforms.uFrame.value = (uniforms.uFrame.value + 1) % 64
    uniforms.uHistoryWeight.value = historyValid ? preset.history : 0

    const previous = current
    current = 1 - current
    uniforms.uHistory.value = targets[previous].texture

    const previousTarget = renderer.getRenderTarget()
    renderer.setRenderTarget(targets[current])
    marchQuad.render(renderer)

    // Sun probe: one pixel, a few times a second, read back without stalling the GPU
    sunProbe.wait -= delta
    if (!sunProbe.pending && sunProbe.wait <= 0) {
      sunProbe.wait = 0.2
      sunProbe.pending = true
      renderer.setRenderTarget(sunTarget)
      sunQuad.render(renderer)
      renderer
        .readRenderTargetPixelsAsync(sunTarget, 0, 0, 1, 1, sunPixel)
        .then(() => {
          state.sunVisibility = sunPixel[0] / 255
        })
        .catch(() => {})
        .finally(() => {
          sunProbe.pending = false
        })
    }
    renderer.setRenderTarget(previousTarget)

    previousViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    historyValid = true
  }

  return state
}
