import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

// Intro: the landscape emerges through an organic opening in a warm off-white veil.
//
// - Until the first frames are drawn, a plain off-white cover in the page (index.html)
//   hides everything, so nothing flashes before the scene exists
// - A large "Loading" with animated dots shows on the off-white screen for loadingTime
//   seconds from the start of the page load (longer if the scene takes longer to be
//   ready), then fades as the opening appears
// - The veil itself is one full-screen pass drawn over the finished frame by the scene's
//   own renderer, from the scene's own animation loop (no second renderer or loop). Its
//   shader builds a screen-space field: distance from a point near the middle, stretched
//   into broad rounded lobes by noise sampled around the circle, and warped by slow,
//   fixed noise so the perimeter has soft bumps and dents rather than a clean curve. A
//   threshold on that field grows over the reveal, so the opening spreads outward
//   unevenly. The noise never changes over time, only the threshold, so the edge flows
//   without flicker or crawl
// - The edge is feathered, with a faint green haze just outside it on the white side
// - The UI fades in and the camera controls are handed back while the opening is still
//   sweeping out past the screen edges (uiAt, a fraction of the reveal), and the pass
//   stops once it is past every edge
// - Reduced motion gets a short reveal. If the shader cannot be built, the page cover
//   simply fades out instead

const veilVertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const veilFragmentShader = /* glsl */ `
  uniform float uRadius;
  uniform float uEdge;
  uniform float uFade;
  uniform float uAspect;
  uniform vec3 uVeilColor;
  uniform vec3 uFringeColor;
  varying vec2 vUv;

  float hash(vec2 p) {
    p = fract(p * vec2(0.1031, 0.1030));
    p += dot(p, p.yx + 33.33);
    return fract((p.x + p.y) * p.x);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i++) {
      value += noise(p) * amplitude;
      p = p * 2.03 + vec2(13.7, 7.1);
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    // Screen space, square units, centered a little above the middle
    vec2 p = (vUv - vec2(0.52, 0.46)) * vec2(uAspect, 1.0);

    // Domain warp: fixed, slow noise pushes every point around, so the outline bends
    vec2 warp = vec2(fbm(p * 1.7 + 3.1), fbm(p * 1.7 + 8.4)) - 0.5;
    vec2 q = p + warp * 0.32;

    // Broad lobes: the opening reaches further in some directions than others. Sampled
    // on a circle, so the lobes join up all the way round
    float angle = atan(q.y, q.x);
    vec2 around = vec2(cos(angle), sin(angle));
    float lobes = fbm(around * 1.35 + 21.0) * 0.75 + fbm(around * 2.9 + 5.0) * 0.25;
    float distance = length(q) / (0.65 + 0.9 * lobes);

    // Small soft bumps along the edge
    distance += (fbm(q * 5.5 + 40.0) - 0.5) * 0.06;

    // 1 outside the opening (veil), 0 inside, with a soft feather between
    float veil = smoothstep(uRadius - uEdge, uRadius + uEdge, distance);

    // A faint green haze just outside the edge, fading out into the white
    float outside = (distance - uRadius) / (uEdge * 2.2);
    float fringe = exp(-outside * outside);
    vec3 color = mix(uVeilColor, uFringeColor, fringe * 0.22);

    gl_FragColor = vec4(color, veil * (1.0 - uFade));
  }
`

const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10)

export const createIntroReveal = (renderer, { controls, duration = 3, uiAt = 0.45, loadingTime = 2.5 }) => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const revealDuration = reducedMotion ? 1 : duration
  const cover = document.querySelector('.intro-cover')
  const loading = document.querySelector('.intro-loading')
  // (the page starts with this class, so the UI is hidden from the very first paint)
  document.body.classList.add('intro-active')
  controls.enabled = false

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uRadius: { value: 0 },
      uEdge: { value: 0.03 },
      uFade: { value: 0 },
      uAspect: { value: 1 },
      uVeilColor: { value: new THREE.Color().setRGB(0.965, 0.957, 0.93) },
      uFringeColor: { value: new THREE.Color().setRGB(0.78, 0.87, 0.72) },
    },
    vertexShader: veilVertexShader,
    fragmentShader: veilFragmentShader,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const quad = new FullScreenQuad(material)

  const state = { done: false, frames: 0, slowFrames: 0, elapsed: 0, started: false }

  // If the veil's shader fails, fall back to fading out the page cover
  let failed = false
  const previousShaderError = renderer.debug.onShaderError
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
    failed = true
    console.error('Intro veil shader failed; using a plain fade instead')
    if (previousShaderError) previousShaderError(gl, program, vertex, fragment)
  }

  const hideLoading = () => {
    if (!loading || loading.classList.contains('is-hidden')) return
    loading.classList.add('is-hidden')
    setTimeout(() => loading.remove(), 700)
  }

  const showInterface = () => {
    document.body.classList.remove('intro-active')
    controls.enabled = true
  }

  const finish = () => {
    state.done = true
    quad.dispose()
    material.dispose()
    renderer.debug.onShaderError = previousShaderError
    showInterface()
    if (cover) {
      cover.classList.add('is-hidden')
      setTimeout(() => cover.remove(), 900)
    }
    hideLoading()
  }

  // Call once per frame, after the scene has been drawn to the canvas
  state.render = (delta) => {
    if (state.done) return
    state.frames++
    // Ready once the first frames are drawn (shaders compiled, the shadow map drawn) and
    // frame times have settled (at most a second and a half in any case), and once the
    // loading text has shown for its time
    if (!state.started) {
      state.slowFrames = delta > 0.05 ? state.slowFrames + 1 : 0
      state.elapsed += delta
      const ready = (state.frames > 3 && state.slowFrames === 0) || state.elapsed > 1.5
      if (ready && performance.now() / 1000 >= (reducedMotion ? Math.min(loadingTime, 1) : loadingTime)) {
        state.started = true
        // The text fades out first, then the opening appears
        state.elapsed = reducedMotion ? 0 : -0.45
        hideLoading()
      }
    } else {
      state.elapsed += Math.min(delta, 0.05)
    }

    const opening = state.started && state.elapsed >= 0
    const t = opening ? Math.min(state.elapsed / revealDuration, 1) : 0
    // A small opening that lingers a moment, then spreads ever faster past the edges
    const growth = 0.75 * smootherstep(t) + 0.25 * t
    const uniforms = material.uniforms
    // Fully closed while the loading text shows
    uniforms.uRadius.value = opening ? 0.045 + 1.75 * Math.pow(growth, 1.15) : -1
    uniforms.uEdge.value = 0.022 + 0.035 * growth
    uniforms.uFade.value = THREE.MathUtils.smoothstep(t, 0.85, 1)
    uniforms.uAspect.value = renderer.domElement.width / Math.max(renderer.domElement.height, 1)

    const autoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.setRenderTarget(null)
    quad.render(renderer)
    renderer.autoClear = autoClear

    // The veil is now on screen, so the page cover can go
    if (cover && !cover.classList.contains('is-hidden') && !failed) cover.classList.add('is-hidden')
    if (failed) {
      finish()
      return
    }
    if (t >= uiAt && document.body.classList.contains('intro-active')) showInterface()
    if (t >= 1) finish()
  }

  return state
}
