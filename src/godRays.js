import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

// God rays: shafts of sunlight streaming out from the visible sun, broken up by the trees,
// terrain and clouds in front of it.
//
// - The scene is drawn into an offscreen target (multisampled, like the canvas, so edges
//   and the flowers' alpha-to-coverage stay smooth) along with its depth
// - The light source is only open sky near the sun, read from that depth (the sky dome
//   writes no depth, so the sky is wherever nothing else was drawn) and dimmed by the
//   clouds' transmittance, so clouds in front of the sun cut the rays off as well
// - At half resolution, that light is smeared along lines toward the sun's position on
//   screen (a radial blur), so every gap between the needles or past a cloud edge leaves
//   a streak pointing back at the sun
// - The rays are added over the scene, and the result is converted to the display's color
//   space on the way to the canvas
//
// The sun's direction comes from the same vector as the sun light and the sun disc, and
// its screen position is projected with the same camera, so they can never disagree

const quadVertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

// Sunlight seen at each point on screen, worked out once per pixel so the blur below only
// reads it. r: the sun disc and its tight glow, where the sky is open and not covered by
// cloud. g: a wider, fainter halo around it, likewise. b: the same light as if nothing in
// the scene stood in front of the sun (clouds still count), and a: as if neither the
// scene nor clouds did. These let the blur tell how much of the sun is blocked
const maskShader = /* glsl */ `
  uniform sampler2D uDepth;
  uniform sampler2D uClouds;
  uniform mat4 uInverseProjection;
  uniform mat4 uCameraWorld;
  uniform vec3 uSunDirection;
  uniform float uSunCos;
  varying vec2 vUv;

  void main() {
    vec4 view = uInverseProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 direction = normalize((uCameraWorld * vec4(view.xyz / view.w, 0.0)).xyz);
    float toSun = max(dot(direction, uSunDirection), 0.0);
    float disc = smoothstep(uSunCos - (1.0 - uSunCos) * 0.6, uSunCos, toSun);
    float glow = disc + pow(toSun, 400.0) * 0.8;
    // The halo is what grass blades, petals and needles in front of a low sun cut into
    // long separate shafts
    float halo = pow(toSun, 60.0) * 0.3;
    // Dimmed by cloud the same way as the sun in the sky dome (shining through thin cloud)
    float clouds = pow(texture2D(uClouds, vUv).a, 0.3);
    float open = texture2D(uDepth, vUv).x >= 0.99999 ? 1.0 : 0.0;
    gl_FragColor = vec4(vec3(glow, halo, glow + halo) * clouds * vec3(open, open, 1.0), glow + halo);
  }
`

// Radial blur of the mask toward the sun's position on screen
const raysShader = /* glsl */ `
  uniform sampler2D uMask;
  uniform sampler2D uDepth;
  uniform vec2 uSunUv;
  uniform float uLength;
  uniform float uFrame;
  varying vec2 vUv;

  const int SAMPLES = 64;

  void main() {
    vec2 stepUv = (uSunUv - vUv) * uLength / float(SAMPLES);
    // Offset each pixel's first sample a little, differently each frame, so the fixed
    // sample spacing shows as faint grain instead of rings
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy + 5.588238 * uFrame, vec2(0.06711056, 0.00583715))));
    vec2 uv = vUv + stepUv * jitter;

    vec4 rays = vec4(0.0);
    float weight = 1.0;
    float total = 0.0;
    for (int i = 0; i < SAMPLES; i++) {
      rays += texture2D(uMask, uv) * weight;
      total += weight;
      weight *= 0.975;
      uv += stepUv;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    }
    rays /= total;
    // How much of the sunlight along this line something in the scene blocks. Where light
    // is partly cut off (the sun right behind grass or needles) a soft glow leaks through
    // the gaps; in open sky the sun keeps just its tight glow
    float blocked = rays.b > 1e-4 ? clamp(1.0 - (rays.r + rays.g) / rays.b, 0.0, 1.0) : 0.0;
    float glow = rays.r * (1.0 + 0.4 * blocked) + rays.g * 0.4 * blocked;
    // How open the way to the sun is from here, counting clouds as well (1 = clear). This
    // is smooth and radial, so the sunburst beams fade gently behind whatever is in front
    float open = rays.a > 1e-4 ? clamp((rays.r + rays.g) / rays.a, 0.0, 1.0) : 1.0;
    // Whether this pixel itself is open sky, so the beams lie over the sky and only faintly
    // over the trees and ground in front of it (half resolution keeps the edge soft)
    float sky = texture2D(uDepth, vUv).x >= 0.99999 ? 1.0 : 0.0;
    gl_FragColor = vec4(glow, open, sky, 1.0);
  }
`

// The sunburst, drawn over the scene: a bright round core and broad, soft beams fanning out
// from the sun's position on screen, like a diffused studio flash. Each beam covers a fixed
// angle, so it widens with distance into a long triangle; widths and brightness vary from
// beam to beam (two overlapping sets of beams, stable random values per beam) and drift a
// little over time. Everything fades smoothly with distance from the sun, and dims where
// something stands between the viewer and the sun. Added with a screen blend, which can
// brighten toward white but never past it, so the sky keeps its color
const compositeShader = /* glsl */ `
  uniform sampler2D uScene;
  uniform sampler2D uRays;
  uniform vec3 uSunColor;
  uniform float uStrength;
  uniform float uBurst;
  uniform vec2 uSunUv;
  uniform float uAspect;
  uniform float uReach;
  uniform float uTime;
  varying vec2 vUv;

  float hash(float n) {
    return fract(sin(n * 127.1 + 311.7) * 43758.5453);
  }

  // One set of beams around the full circle: count sectors, one beam in each, with its
  // own width and brightness. turn (in sectors) rotates the set
  float beamSet(float angle, float count, float turn, float seed) {
    float x = angle * count + turn;
    float id = mod(floor(x), count);
    float local = fract(x) - 0.5;
    float width = mix(0.2, 0.42, hash(id + seed));
    float brightness = mix(0.35, 1.0, hash(id * 1.37 + seed * 2.1));
    brightness *= 0.85 + 0.15 * sin(uTime * 0.35 + id * 2.3 + seed);
    // Soft-edged triangle across the beam: a brighter middle with gently feathered sides
    return (1.0 - smoothstep(width * 0.15, width, abs(local))) * brightness;
  }

  void main() {
    vec3 color = texture2D(uScene, vUv).rgb;
    vec4 rays = texture2D(uRays, vUv);
    color += uSunColor * rays.r * uStrength;

    vec2 offset = (vUv - uSunUv) * vec2(uAspect, 1.0);
    float distance = length(offset);
    float angle = atan(offset.y, offset.x) / 6.2831853 + 0.5;
    float beams = beamSet(angle, 8.0, 0.13, 3.1) * 0.85 + beamSet(angle, 13.0, 0.61, 7.7) * 0.2;
    // The beams fade out with distance; the core is a bright round flash in the middle,
    // inside a soft haze that thins out into the sky
    float falloff = exp(-distance / uReach);
    float core = exp(-distance * distance / 0.012) * 0.9 + exp(-distance / 0.13) * 0.3 + exp(-distance / 0.35) * 0.08;
    float burst = (beams * falloff * smoothstep(0.0, 0.06, distance) + core) * uBurst * mix(0.04, 1.0, rays.g * rays.g) * mix(0.25, 1.0, rays.b);
    vec3 light = clamp(uSunColor * burst, 0.0, 1.0);
    color = 1.0 - (1.0 - clamp(color, 0.0, 1.0)) * (1.0 - light);

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`

export const createGodRays = (renderer) => {
  // 8 bits per channel, stored sRGB-encoded (the GPU encodes on write and decodes on
  // read), like the canvas itself: half the memory traffic of a float target, and no
  // banding in the shade. Everything drawn is already rolled off to at most 1
  const sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
    samples: 4,
    depthTexture: new THREE.DepthTexture(1, 1),
  })
  // Both at half resolution: the rays are soft, so this costs nothing visible
  const maskTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })
  const raysTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })

  const maskMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uDepth: { value: sceneTarget.depthTexture },
      uClouds: { value: null },
      uInverseProjection: { value: new THREE.Matrix4() },
      uCameraWorld: { value: new THREE.Matrix4() },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uSunCos: { value: Math.cos(THREE.MathUtils.degToRad(1.1)) },
    },
    vertexShader: quadVertexShader,
    fragmentShader: maskShader,
    depthTest: false,
    depthWrite: false,
  })
  const maskQuad = new FullScreenQuad(maskMaterial)

  const raysMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uMask: { value: maskTarget.texture },
      uDepth: { value: sceneTarget.depthTexture },
      uSunUv: { value: new THREE.Vector2() },
      uLength: { value: 0.9 },
      uFrame: { value: 0 },
    },
    vertexShader: quadVertexShader,
    fragmentShader: raysShader,
    depthTest: false,
    depthWrite: false,
  })
  const raysQuad = new FullScreenQuad(raysMaterial)

  const compositeMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uScene: { value: sceneTarget.texture },
      uRays: { value: raysTarget.texture },
      uSunColor: { value: new THREE.Color() },
      uStrength: { value: 0 },
      uBurst: { value: 0 },
      uSunUv: { value: new THREE.Vector2() },
      uAspect: { value: 1 },
      uReach: { value: 0.32 },
      uTime: { value: 0 },
    },
    vertexShader: quadVertexShader,
    fragmentShader: compositeShader,
    depthTest: false,
    depthWrite: false,
  })
  const compositeQuad = new FullScreenQuad(compositeMaterial)

  const sunClip = new THREE.Vector4()
  const bufferSize = new THREE.Vector2()

  const state = {
    // Set by the scene: rays brightness (0 = off; drives the sunburst and the glow through
    // gaps) and how far they reach across the screen (1 = farthest)
    strength: 0.6,
    length: 0.9,
    sunDirection: maskMaterial.uniforms.uSunDirection.value,
    sunColor: compositeMaterial.uniforms.uSunColor.value,
    set sunCos(value) {
      maskMaterial.uniforms.uSunCos.value = value
    },
  }

  state.setSize = () => {
    renderer.getDrawingBufferSize(bufferSize)
    sceneTarget.setSize(bufferSize.x, bufferSize.y)
    compositeMaterial.uniforms.uAspect.value = bufferSize.x / bufferSize.y
    const width = Math.max(1, Math.round(bufferSize.x / 2))
    const height = Math.max(1, Math.round(bufferSize.y / 2))
    maskTarget.setSize(width, height)
    raysTarget.setSize(width, height)
  }
  state.setSize()

  // Draws the scene with rays to the canvas, in place of renderer.render(scene, camera)
  state.render = (scene, camera, cloudsTexture) => {
    renderer.setRenderTarget(sceneTarget)
    renderer.render(scene, camera)

    // Where the sun is on screen: its direction, as a point infinitely far away (w = 0)
    sunClip.set(state.sunDirection.x, state.sunDirection.y, state.sunDirection.z, 0)
    sunClip.applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix)
    let strength = state.strength
    if (sunClip.w > 1e-4) {
      const x = (sunClip.x / sunClip.w) * 0.5 + 0.5
      const y = (sunClip.y / sunClip.w) * 0.5 + 0.5
      raysMaterial.uniforms.uSunUv.value.set(x, y)
      // Fade out as the sun leaves the screen: the rays need it in view to start from
      const outside = Math.max(Math.abs(x - 0.5), Math.abs(y - 0.5)) - 0.5
      strength *= 1 - THREE.MathUtils.smoothstep(outside, 0, 0.35)
    } else {
      // Behind the camera
      strength = 0
    }
    const composite = compositeMaterial.uniforms
    composite.uStrength.value = strength
    composite.uBurst.value = strength * 1.3
    composite.uReach.value = 0.15 + state.length * 0.35
    composite.uSunUv.value.copy(raysMaterial.uniforms.uSunUv.value)
    composite.uTime.value = performance.now() / 1000

    if (strength > 0) {
      const mask = maskMaterial.uniforms
      mask.uClouds.value = cloudsTexture
      mask.uInverseProjection.value.copy(camera.projectionMatrixInverse)
      mask.uCameraWorld.value.copy(camera.matrixWorld)
      renderer.setRenderTarget(maskTarget)
      maskQuad.render(renderer)

      const rays = raysMaterial.uniforms
      rays.uLength.value = state.length
      rays.uFrame.value = (rays.uFrame.value + 1) % 64
      renderer.setRenderTarget(raysTarget)
      raysQuad.render(renderer)
    }

    renderer.setRenderTarget(null)
    compositeQuad.render(renderer)
  }

  return state
}
