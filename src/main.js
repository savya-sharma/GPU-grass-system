import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { ImprovedNoise } from 'three/examples/jsm/math/ImprovedNoise.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import GUI from 'three/examples/jsm/libs/lil-gui.module.min.js'
import { createVolumetricClouds, cloudQualityPresets } from './clouds.js'
import { createGodRays } from './godRays.js'
import { createBlackPines } from './pines.js'
import { createBoulderGeometry, createRandom, graniteMaterial } from './rocks.js'

// Canvas
const canvas = document.querySelector('canvas.webgl')

// Scene
const scene = new THREE.Scene()
scene.background = new THREE.Color('#a8d0ff')

// Sizes
const sizes = {
  width: window.innerWidth,
  height: window.innerHeight,
}

// Camera. The starting view: standing low on the island's south-west slope, looking up
// across the rock trail toward the pines, with the sun low in the upper left. Matched to a
// reference frame (the big boulder centered, the pines' trunks spread across the right).
// Used on load and by "reset camera" in the panel; afterwards the controls are free
const cameraStart = {
  fov: 60,
  position: new THREE.Vector3(-5.157, 4.615, 8.195),
  target: new THREE.Vector3(-0.821, 4.068, 1.495),
}
const camera = new THREE.PerspectiveCamera(cameraStart.fov, sizes.width / sizes.height, 0.1, 100)
camera.position.copy(cameraStart.position)
scene.add(camera)

// Controls
const controls = new OrbitControls(camera, canvas)
controls.enableDamping = true
controls.target.copy(cameraStart.target)
// The ground is a single thin surface, seen only from above. Orbiting down stops just above
// ground level (see limitCameraHeight), so the camera can come right down to a view along
// the ground but never below it. Panning slides the look-at point across the ground rather
// than up and down, so it stays above the ground too
controls.maxPolarAngle = Math.PI / 2
controls.screenSpacePanning = false

// Lowest the camera may go: just above the island's highest rim point (about 0.8), so the
// rim is always seen from above, and never closer than 0.3 to the ground right under it.
// Worked into the orbit limit each frame, from the current zoom, so the controls stop
// there on their own and nothing fights them
const cameraFloor = { rim: 1.1, clearance: 0.3 }
const limitCameraHeight = () => {
  const { x, z } = camera.position
  const overIsland = Math.abs(x) < groundSize / 2 && Math.abs(z) < groundSize / 2
  const floor = Math.max(cameraFloor.rim, overIsland ? getGroundHeight(x, z) + cameraFloor.clearance : -Infinity)
  const distance = camera.position.distanceTo(controls.target)
  const below = THREE.MathUtils.clamp((controls.target.y - floor) / Math.max(distance, 1e-3), -1, 1)
  controls.maxPolarAngle = Math.PI / 2 + Math.asin(below)
}
controls.update()
// What controls.reset() returns to
controls.saveState()

// Lights. The sun (the directional light below) is the only source of direct light: its
// direction drives the visible sun disc, shading, shadows, grass translucency, cloud
// lighting and the god rays (see updateSun). The ambient light is only a low, even fill,
// standing in for the sky's light, so shade is never fully black
const ambientLight = new THREE.AmbientLight('#ffffff', 0.4)
scene.add(ambientLight)

// Shared with the grass shader: how much sunlight shines through back-lit blades
const lightingUniforms = {
  uGrassTranslucency: { value: 1.28 },
}

const directionalLight = new THREE.DirectionalLight('#ffffff', 2)
// The sun starts low among the clouds, at azimuth -86 degrees around the horizon (the
// rock trail's straight-line heading is -103.5), so the stones' shadows stretch back
// toward the viewer. From the starting camera it shows near the top of the screen, in the
// band of sky where the clouds are. Elevation is degrees above the horizon. Placed 30
// units out so the shadow camera starts above the tallest treetops; only the direction
// affects the lighting
const sunStart = { elevation: 7, azimuth: -86 }
directionalLight.position
  .setFromSphericalCoords(
    30,
    THREE.MathUtils.degToRad(90 - sunStart.elevation),
    // Spherical azimuth is measured from +z toward +x; the panel's from +x toward +z
    THREE.MathUtils.degToRad(90 - sunStart.azimuth)
  )
scene.add(directionalLight)

// Frozen shadows. Everything that casts a shadow here is static scenery: tree trunks and
// foliage, and the rocks. Everything that moves (the grass and flowers swaying in the
// wind) only receives shadows and never casts them. So this light's shadow map is drawn
// once, on the first frame after the whole scene is built, and then never again: no
// per-frame shadow pass, and nothing in it can shimmer or flicker as the field animates.
// The freeze is per light (shadow.autoUpdate), not renderer-wide, so another light could
// still cast live shadows from moving objects if one is ever added. Call
// refreshStaticShadows() after moving the light or any shadow-casting scenery
directionalLight.castShadow = true
const sunShadow = directionalLight.shadow
sunShadow.mapSize.set(2048, 2048)
// An orthographic box around the whole terrain, trees included, seen from the light
sunShadow.camera.left = -15
sunShadow.camera.right = 15
sunShadow.camera.top = 15
sunShadow.camera.bottom = -15
sunShadow.camera.near = 5
sunShadow.camera.far = 55
// Soft edges (PCF filtering radius, in texels), and a light touch of bias against acne on
// the faceted rocks, which both cast and receive
sunShadow.radius = 6
sunShadow.bias = -0.0005
sunShadow.normalBias = 0.03
// Shade blocks most of the sun, so it reads as the one light being blocked; the ambient
// fill (and the remaining 20%) keeps it from turning into black holes in the grass
sunShadow.intensity = 0.8
sunShadow.autoUpdate = false
const refreshStaticShadows = () => {
  sunShadow.needsUpdate = true
}
refreshStaticShadows()

// Marks every mesh in an object as casting and/or receiving shadows
const setShadows = (object, cast, receive) => {
  object.traverse((child) => {
    if (!child.isMesh) return
    child.castShadow = cast
    child.receiveShadow = receive
  })
}

// Surface
const groundSize = 20
// Two segments per unit, fine enough for the small hills on the left to stay smooth
const gridDivisions = 40

// Natural terrain: low-frequency layered noise gives soft, rolling waves
const noise = new ImprovedNoise()
const terrainHeight = 1.5
const terrainFrequency = 0.07
const octaves = 2

// Terrain shape, as in the reference: one smooth, low dome. The ground is highest around
// the middle of the island (by the rocks) and curves away evenly toward every edge, more
// steeply near the rim, so the island reads as a rounded mound. The rolling noise is
// kept faint on top so the dome surface isn't perfectly regular
const domeHeight = 1.5
const domeRadius = 14.2
const rollingStrength = 0.35

const terrainDome = (x, z) => {
  const r = Math.min(Math.hypot(x, z) / domeRadius, 1)
  return domeHeight * (1 - r * r)
}

// The rolling, noise-only part of the ground (used to tell valleys from crests)
const getRollingHeight = (x, z) => {
  let height = 0
  let amplitude = terrainHeight
  let frequency = terrainFrequency

  for (let i = 0; i < octaves; i++) {
    height += noise.noise(x * frequency, z * frequency, 0) * amplitude
    amplitude *= 0.5
    frequency *= 2
  }

  return height
}

const getSurfaceHeight = (x, z) => getRollingHeight(x, z) * rollingStrength + terrainDome(x, z)

// Biomes: every look of the field comes from these few numbers, read by both the ground
// and the grass shaders. Pick one in the panel (or with ?biome=dry in the URL), then tweak.
// - map*: shape of the ground map (how big the patches are, how sharply they contrast,
//   how ragged their edges are)
// - threshold / softness: where on the mask grass gives way to soil, and how gradually
// - centerGrass: how much the middle of the terrain is guaranteed to be grassy
// - sparseDensity: fraction of blades still growing on fully bare ground
// - heightMin / heightMax: blade height on bare vs. lush ground, in world units
// - grassTint / dryColor / dryness / biomeVariation / sparseDryness: blade colors
// - soilTint: how much blades on thin ground take on the soil color
// - turfColor / soilColor / soilColorAlt / soilGrain: ground palette and how mottled the
//   soil is (color only, never density)
const biomePresets = {
  healthy: {
    mapScale: 0.17, mapContrast: 1, mapDetail: 0.55, mapSeed: 1, valleyGrass: 0.1,
    threshold: 0.5, softness: 0.16, sparseDensity: 0.1, centerGrass: 0.6,
    heightMin: 0.06, heightMax: 0.3, heightVariation: 0.5,
    grassTint: '#ffffff', dryColor: '#b9a255', dryness: 0, biomeVariation: 0.12, sparseDryness: 0.1, soilTint: 0.75,
    turfColor: '#5c8a0c', soilColor: '#e0b07a', soilColorAlt: '#dbab75', soilGrain: 0.03,
  },
  sparse: {
    mapScale: 0.16, mapContrast: 1.25, mapDetail: 0.5, mapSeed: 2, valleyGrass: 0.25,
    threshold: 0.58, softness: 0.18, sparseDensity: 0.05, centerGrass: 0.2,
    heightMin: 0.06, heightMax: 0.34, heightVariation: 0.4,
    grassTint: '#f2f5e6', dryColor: '#b49a58', dryness: 0.1, biomeVariation: 0.25, sparseDryness: 0.65, soilTint: 0.6,
    turfColor: '#55802a', soilColor: '#c5a063', soilColorAlt: '#c19c5e', soilGrain: 0.03,
  },
  dry: {
    mapScale: 0.12, mapContrast: 1, mapDetail: 0.5, mapSeed: 3, valleyGrass: 0.2,
    threshold: 0.35, softness: 0.2, sparseDensity: 0.1, centerGrass: 0.3,
    heightMin: 0.08, heightMax: 0.38, heightVariation: 0.4,
    grassTint: '#f5ecc8', dryColor: '#c8a95c', dryness: 0.7, biomeVariation: 0.25, sparseDryness: 0.3, soilTint: 0.45,
    turfColor: '#7b7a34', soilColor: '#8b6b44', soilColorAlt: '#a3825a', soilGrain: 0.15,
  },
  mixed: {
    mapScale: 0.12, mapContrast: 1, mapDetail: 0.5, mapSeed: 4, valleyGrass: 0.15,
    threshold: 0.32, softness: 0.16, sparseDensity: 0.1, centerGrass: 0.35,
    heightMin: 0.1, heightMax: 0.44, heightVariation: 0.35,
    grassTint: '#ffffff', dryColor: '#c9b052', dryness: 0.05, biomeVariation: 0.85, sparseDryness: 0.4, soilTint: 0.35,
    turfColor: '#5a8424', soilColor: '#c5a063', soilColorAlt: '#c19c5e', soilGrain: 0.03,
  },
  redDesert: {
    mapScale: 0.2, mapContrast: 1.3, mapDetail: 0.5, mapSeed: 5, valleyGrass: 0.35,
    threshold: 0.66, softness: 0.16, sparseDensity: 0.04, centerGrass: 0.12,
    heightMin: 0.05, heightMax: 0.3, heightVariation: 0.45,
    grassTint: '#e9e6c0', dryColor: '#c6a362', dryness: 0.45, biomeVariation: 0.3, sparseDryness: 0.6, soilTint: 0.55,
    turfColor: '#6f7433', soilColor: '#9a5433', soilColorAlt: '#b8754a', soilGrain: 0.15,
  },
}

const initialBiome = new URLSearchParams(window.location.search).get('biome')
const biomeState = { biome: initialBiome in biomePresets ? initialBiome : 'healthy' }
// bladeWidth and rockGrass (how lush the grass is around rocks) aren't part of a biome, so
// switching presets leaves them alone
// The scene starts from the preset with a few values of its own on top (sharper, more
// detailed patch edges and grainier soil); picking a preset in the panel later gives that
// preset exactly
const startingGround = { mapContrast: 1.8, mapDetail: 0.75, soilGrain: 0.2 }
const groundSettings = { bladeWidth: 1.35, rockGrass: 0.55, ...biomePresets[biomeState.biome], ...startingGround }

// Ground map: one procedural texture stretched once over the whole terrain and read by
// both the ground and the grass. Its channels are deliberately independent:
//   r: grass mask, 0 = bare soil, 1 = lush grass. The ONLY input to grass density, blade
//      height and blade health, so all of those always agree with each other
//   g: soil palette variation (ground color only)
//   b: biome patches where blades turn yellow (color only)
//   a: fine soil grain (ground color only)
// Recoloring therefore never moves the grass, and reshaping the grass never recolors soil.
//
// Map settings can't be interpolated, so a changed map is built in the background and
// crossfaded in: the shaders read mix(previous, current, uMapBlend). Patches morph from
// the old layout to the new one instead of jumping
const groundMapResolution = 256

const createGroundMap = () => {
  const data = new Uint8Array(groundMapResolution * groundMapResolution * 4)
  const texture = new THREE.DataTexture(data, groundMapResolution, groundMapResolution)
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  return texture
}
const previousGroundMap = createGroundMap()
const groundMap = createGroundMap()
const previousGroundMapData = previousGroundMap.image.data
const groundMapData = groundMap.image.data
// 0 shows the previous map, 1 the current one. Eased toward 1 in the animation loop
const mapFade = { value: 1 }

// roughness: how much each finer layer adds. Higher gives ragged edges and small islands
const fbm = (x, z, seed, layers, roughness = 0.5) => {
  let value = 0
  let amplitude = 0.5
  let frequency = 1
  for (let i = 0; i < layers; i++) {
    value += noise.noise(x * frequency, z * frequency, seed) * amplitude
    amplitude *= roughness
    frequency *= 2
  }
  return value
}

// Raw noise drifts in average and spread with scale and seed, so each channel is
// normalized to mean 0.5 and a fixed spread. That keeps threshold meaning roughly the
// same coverage whatever the patch size or seed
const writeNormalizedChannel = (values, channel, contrast, target, extra) => {
  let mean = 0
  for (const v of values) mean += v
  mean /= values.length
  let variance = 0
  for (const v of values) variance += (v - mean) ** 2
  const spread = Math.sqrt(variance / values.length) || 1

  for (let i = 0; i < values.length; i++) {
    const v = 0.5 + ((values[i] - mean) / spread) * 0.22 * contrast + (extra ? extra[i] : 0)
    target[i * 4 + channel] = Math.round(THREE.MathUtils.clamp(v, 0, 1) * 255)
  }
}

// Texel centers map to world xz exactly as groundMapUv() does in the shaders
const groundMapTexelToWorld = (i) => ((i + 0.5) / groundMapResolution - 0.5) * groundSize

// Builds the map a few rows at a time (a generator, resumed each frame) so a rebuild
// never stalls a frame. Writes into `target` only once every row is done. Background
// builds (withBlades) also sample the new mask under every blade spot up front, so the
// frame the crossfade starts on has almost nothing left to do
function* buildGroundMapRows(target, withBlades = false) {
  const { mapScale, mapContrast, mapDetail, mapSeed, valleyGrass } = groundSettings
  const texels = groundMapResolution * groundMapResolution
  const grass = new Float32Array(texels)
  const soil = new Float32Array(texels)
  const biome = new Float32Array(texels)
  const grain = new Float32Array(texels)
  // Lifts added to the mask: rocks sit in lush grass, as in the reference, and the middle
  // of the terrain is well covered
  const maskLift = new Float32Array(texels)
  const rockGrassStrength = groundSettings.rockGrass
  const centerGrassStrength = groundSettings.centerGrass
  const seed = mapSeed * 7.31 + 11

  for (let row = 0; row < groundMapResolution; row++) {
    const z = groundMapTexelToWorld(row)
    for (let column = 0; column < groundMapResolution; column++) {
      const x = groundMapTexelToWorld(column)
      const i = row * groundMapResolution + column
      // Valleys hold water and stay lusher; crests dry out. Terrain height is -1..1 scaled
      grass[i] = fbm(x * mapScale, z * mapScale, seed, 6, mapDetail) - ((getRollingHeight(x, z) * rollingStrength) / terrainHeight) * valleyGrass * 0.3
      soil[i] = fbm(x * 0.22, z * 0.22, seed + 3.1, 3)
      biome[i] = fbm(x * 0.09, z * 0.09, seed + 5.7, 3)
      grain[i] = fbm(x * 1.6, z * 1.6, seed + 9.3, 2)
      const rockLift = rockGrassStrength > 0 ? rockSurround(x, z) * rockGrassStrength : 0
      maskLift[i] = Math.max(rockLift, centerSurround(x, z) * centerGrassStrength)
    }
    yield
  }

  writeNormalizedChannel(grass, 0, mapContrast, target, maskLift)
  yield
  writeNormalizedChannel(soil, 1, 1, target)
  yield
  writeNormalizedChannel(biome, 2, 1, target)
  yield
  writeNormalizedChannel(grain, 3, 1, target)

  if (!withBlades) return
  mapBuild.bladeMask ??= new Float32Array(candidateCount)
  for (let i = 0; i < candidateCount; i++) {
    mapBuild.bladeMask[i] = sampleGrassMask(candidateX[i], candidateZ[i], target)
    if (i % 8192 === 8191) yield
  }
}


// Background rebuilds: a request while one is running is remembered and started as soon
// as it finishes, so dragging a slider keeps morphing toward the latest value
const mapBuild = { job: null, pending: false, scratch: new Uint8Array(groundMapData.length), bladeMask: null }
const requestGroundMap = () => {
  if (mapBuild.job) mapBuild.pending = true
  else mapBuild.job = buildGroundMapRows(mapBuild.scratch, true)
}

// Called once a background build has finished: whatever is on screen right now (possibly
// mid-crossfade) becomes the previous map, and the fresh one fades in on top of it. The
// blade masks follow the same way (bilinear sampling is linear, so blending the samples
// matches sampling the blended map)
const startMapCrossfade = () => {
  const blend = mapFade.value
  for (let i = 0; i < groundMapData.length; i++) {
    previousGroundMapData[i] = Math.round(previousGroundMapData[i] + (groundMapData[i] - previousGroundMapData[i]) * blend)
  }
  groundMapData.set(mapBuild.scratch)
  previousGroundMap.needsUpdate = true
  groundMap.needsUpdate = true

  for (let i = 0; i < candidateCount; i++) {
    candidatePreviousMask[i] += (candidateMask[i] - candidatePreviousMask[i]) * blend
  }
  candidateMask.set(mapBuild.bladeMask)
  densityUpdate.dirty = true
  mapFade.value = 0
}

// Runs the background build for at most `budget` ms of this frame
const advanceGroundMap = (budget) => {
  if (!mapBuild.job) return
  const start = performance.now()
  while (performance.now() - start < budget) {
    if (mapBuild.job.next().done) {
      startMapCrossfade()
      mapBuild.job = mapBuild.pending ? buildGroundMapRows(mapBuild.scratch, true) : null
      mapBuild.pending = false
      return
    }
  }
}

// CPU copy of the GPU lookup: bilinear sample of the mask (r) at a world point, using the
// same texel layout and clamping, so blade placement matches what the shaders see
const sampleGrassMask = (x, z, data) => {
  const last = groundMapResolution - 1
  const fx = THREE.MathUtils.clamp((x / groundSize + 0.5) * groundMapResolution - 0.5, 0, last)
  const fz = THREE.MathUtils.clamp((z / groundSize + 0.5) * groundMapResolution - 0.5, 0, last)
  const x0 = Math.floor(fx)
  const z0 = Math.floor(fz)
  const x1 = Math.min(x0 + 1, last)
  const z1 = Math.min(z0 + 1, last)
  const tx = fx - x0
  const tz = fz - z0
  const row0 = z0 * groundMapResolution
  const row1 = z1 * groundMapResolution
  const a = data[(row0 + x0) * 4]
  const b = data[(row0 + x1) * 4]
  const c = data[(row1 + x0) * 4]
  const d = data[(row1 + x1) * 4]

  const top = a + (b - a) * tx
  const bottom = c + (d - c) * tx
  return (top + (bottom - top) * tz) / 255
}

// Same as grassDensity() in the shaders: the fraction of blades that grow at a point, from
// sparseDensity on bare soil up to 1 in full grass
const grassDensity = (mask, threshold, softness, sparseDensity) =>
  THREE.MathUtils.lerp(sparseDensity, 1, THREE.MathUtils.smoothstep(mask, threshold - softness, threshold + softness))

// Uniforms shared by reference with the ground and grass shaders. The panel never writes
// these directly: it sets groundTargets, and the animation loop eases each uniform toward
// its target, so every change (colors included) blends in rather than snapping
const groundUniforms = {
  uGroundMap: { value: groundMap },
  uPreviousGroundMap: { value: previousGroundMap },
  uMapBlend: mapFade,
  uGroundSize: { value: groundSize },
  uSparseDensity: { value: 0 },
  uBladeWidth: { value: 1 },
  uGrassThreshold: { value: 0 },
  uGrassSoftness: { value: 0 },
  uHeightMin: { value: 0 },
  uHeightMax: { value: 0 },
  uHeightVariation: { value: 0 },
  uGrassTint: { value: new THREE.Color() },
  uDryColor: { value: new THREE.Color() },
  uDryness: { value: 0 },
  uBiomeVariation: { value: 0 },
  uSparseDryness: { value: 0 },
  uSoilTint: { value: 0 },
  uTurfColor: { value: new THREE.Color() },
  uSoilColor: { value: new THREE.Color() },
  uSoilColorAlt: { value: new THREE.Color() },
  uSoilGrain: { value: 0 },
  uShowMask: { value: 0 },
}

// Target value for every eased uniform, keyed by uniform name (numbers or THREE.Colors)
const groundTargets = {
  uGrassTint: new THREE.Color(),
  uDryColor: new THREE.Color(),
  uTurfColor: new THREE.Color(),
  uSoilColor: new THREE.Color(),
  uSoilColorAlt: new THREE.Color(),
}

const applyGroundSettings = () => {
  const s = groundSettings
  const t = groundTargets
  // threshold, softness and sparseDensity have their own targets (densityTargets below),
  // since they must wait for the blade list to catch up
  t.uBladeWidth = s.bladeWidth
  t.uHeightMin = s.heightMin
  t.uHeightMax = Math.max(s.heightMax, s.heightMin)
  t.uHeightVariation = s.heightVariation
  t.uGrassTint.set(s.grassTint)
  t.uDryColor.set(s.dryColor)
  t.uDryness = s.dryness
  t.uBiomeVariation = s.biomeVariation
  t.uSparseDryness = s.sparseDryness
  t.uSoilTint = s.soilTint
  t.uTurfColor.set(s.turfColor)
  t.uSoilColor.set(s.soilColor)
  t.uSoilColorAlt.set(s.soilColorAlt)
  t.uSoilGrain = s.soilGrain
}

// Moves each uniform a fraction `alpha` of the way to its target (alpha 1 = jump there)
const easeUniforms = (uniforms, targets, alpha) => {
  for (const name in targets) {
    const target = targets[name]
    const uniform = uniforms[name]
    if (target.isColor) uniform.value.lerp(target, alpha)
    else uniform.value += (target - uniform.value) * alpha
  }
}

applyGroundSettings()
// Start on the targets: nothing should fade in when the page opens
easeUniforms(groundUniforms, groundTargets, 1)

// Shared GLSL: both materials sample the map and interpret the mask through these exact
// functions, so the grass and the ground under it can never disagree
const groundMapShader = /* glsl */ `
  uniform sampler2D uGroundMap;
  uniform sampler2D uPreviousGroundMap;
  uniform float uMapBlend;
  uniform float uGroundSize;
  uniform float uSparseDensity;
  uniform float uBladeWidth;
  uniform float uGrassThreshold;
  uniform float uGrassSoftness;
  uniform float uHeightMin;
  uniform float uHeightMax;
  uniform float uHeightVariation;
  uniform vec3 uGrassTint;
  uniform vec3 uDryColor;
  uniform float uDryness;
  uniform float uBiomeVariation;
  uniform float uSparseDryness;
  uniform float uSoilTint;
  uniform vec3 uTurfColor;
  uniform vec3 uSoilColor;
  uniform vec3 uSoilColorAlt;
  uniform float uSoilGrain;
  uniform float uShowMask;

  // World xz to map uv: the map spans the ground exactly once, so there is no tiling seam
  vec2 groundMapUv(vec2 worldXZ) {
    return worldXZ / uGroundSize + 0.5;
  }

  // Mid-crossfade this blends the previous map into the new one, so patches morph
  vec4 sampleGroundMap(vec2 worldXZ) {
    vec2 uv = groundMapUv(worldXZ);
    return mix(texture2D(uPreviousGroundMap, uv), texture2D(uGroundMap, uv), uMapBlend);
  }

  // 0 on bare soil, 1 in full grass, with a soft ramp of width 2 * softness between
  float grassAmount(float mask) {
    return smoothstep(uGrassThreshold - uGrassSoftness, uGrassThreshold + uGrassSoftness, mask);
  }

  // Fraction of blades that grow here: sparseDensity on bare soil, all of them in full grass
  float grassDensity(float grass) {
    return mix(uSparseDensity, 1.0, grass);
  }

  // How sun-burned the vegetation is: a global amount, yellow patches from the biome
  // channel, and extra drying where the grass thins out
  float dryAmount(vec4 groundSample, float grass) {
    float patches = smoothstep(0.4, 0.7, groundSample.b) * uBiomeVariation;
    return clamp(uDryness + patches + (1.0 - grass) * uSparseDryness, 0.0, 1.0);
  }

  vec3 groundColor(vec4 groundSample) {
    float grass = grassAmount(groundSample.r);
    float dry = dryAmount(groundSample, grass);
    vec3 soil = mix(uSoilColor, uSoilColorAlt, smoothstep(0.25, 0.75, groundSample.g));
    soil *= 1.0 + (groundSample.a - 0.5) * 2.0 * uSoilGrain;
    // Turf under the blades: green below healthy grass, straw-brown below dry grass
    vec3 turf = mix(uTurfColor, mix(uDryColor, soil, 0.5) * 0.75, dry);
    return mix(soil, turf, grass);
  }
`

// Ground: one segment per grid cell, smooth shaded so it reads as soft turf
const groundGeometry = new THREE.PlaneGeometry(groundSize, groundSize, gridDivisions, gridDivisions)
groundGeometry.rotateX(-Math.PI / 2)

const groundPositions = groundGeometry.attributes.position
for (let i = 0; i < groundPositions.count; i++) {
  const x = groundPositions.getX(i)
  const z = groundPositions.getZ(i)
  groundPositions.setY(i, getSurfaceHeight(x, z))
}
groundGeometry.computeVertexNormals()

const groundMaterial = new THREE.MeshStandardMaterial({
  // Push the surface back slightly so the wireframe draws cleanly on top
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
})
// Color comes from the ground map, looked up by world position (not the plane's own uvs)
// so it lines up exactly with the lookups the grass makes at each blade's root
groundMaterial.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, groundUniforms)

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vGroundXZ;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundXZ = (modelMatrix * vec4(transformed, 1.0)).xz;')

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying vec2 vGroundXZ;\n${groundMapShader}`)
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = groundColor(sampleGroundMap(vGroundXZ));')
    // Mask view: the interpreted grass mask, unlit, white = grass and black = bare soil
    .replace(
      '#include <dithering_fragment>',
      '#include <dithering_fragment>\ngl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(grassAmount(sampleGroundMap(vGroundXZ).r)), uShowMask);'
    )
}

const ground = new THREE.Mesh(groundGeometry, groundMaterial)
// The ground only receives: tree and rock shade falls on it, and it never shades itself
ground.receiveShadow = true
scene.add(ground)

// Wireframe lines: square cells split into triangles, following the surface
const grid = new THREE.Mesh(
  groundGeometry,
  new THREE.MeshBasicMaterial({ color: '#ffffff', wireframe: true, transparent: true, opacity: 0.35 })
)
// Hidden so only the grass shows; set to true to see the cell layout again
grid.visible = false
scene.add(grid)

// Height on the actual low-poly ground: the mesh is flat between grid vertices,
// so interpolate across the triangle the point falls in rather than sampling the noise
const cellSize = groundSize / gridDivisions

const getGroundHeight = (x, z) => {
  const half = groundSize / 2
  const x0 = Math.floor((x + half) / cellSize) * cellSize - half
  const z0 = Math.floor((z + half) / cellSize) * cellSize - half
  const x1 = x0 + cellSize
  const z1 = z0 + cellSize
  const u = (x - x0) / cellSize
  const v = (z - z0) / cellSize

  const ha = getSurfaceHeight(x0, z0)
  const hb = getSurfaceHeight(x0, z1)
  const hc = getSurfaceHeight(x1, z1)
  const hd = getSurfaceHeight(x1, z0)

  // Each cell is split along the diagonal from (x0, z1) to (x1, z0)
  if (u + v <= 1) {
    return ha + (hd - ha) * u + (hb - ha) * v
  }
  return hc + (hb - hc) * (1 - u) + (hd - hc) * (1 - v)
}

// Rock layout traced from the top-down reference: a winding trail running
// from the back (-z) to the front (+z), with sizes matching the reference. One dominant
// boulder near the front (about twice the others), nudged a little off the trail line so
// it clears its neighbor (turn: an extra turn, in radians, to point its split-off block
// into open grass)
const rockLayout = [
  { x: -0.92, z: -2.25, size: 0.6 },
  { x: 0.34, z: -2.71, size: 0.45 },
  { x: 0.25, z: -1.63, size: 0.6 },
  { x: -0.51, z: -1.0, size: 0.15 },
  { x: 0.41, z: -0.5, size: 0.5 },
  { x: -0.87, z: 0.04, size: 0.33 },
  { x: 0.0, z: 1.3, size: 1.0, turn: 1.9 },
  { x: 1.51, z: 2.38, size: 0.5 },
]
// Overall size multiplier for every stone, keeping their sizes relative to each other
const rockScale = 1.25

// Rocks: 8 weathered granite boulders laid out in a winding trail through the center (see
// rocks.js). The larger stones get a smaller split-off block beside them, so they read as
// a cluster of broken pieces. Shapes come from fixed seeds, the same on every load
const rockRandom = createRandom(4242)

const createRock = (hasChunk) => {
  const rock = new THREE.Group()
  rock.add(new THREE.Mesh(createBoulderGeometry(rockRandom), graniteMaterial))

  if (hasChunk) {
    const chunk = new THREE.Mesh(createBoulderGeometry(rockRandom), graniteMaterial)
    chunk.scale.setScalar(0.55 + rockRandom() * 0.15)
    chunk.position.set(0.62, -0.05, (rockRandom() - 0.5) * 0.4)
    chunk.rotation.y = rockRandom() * Math.PI * 2
    rock.add(chunk)
  }

  return rock
}

const rocks = rockLayout.map(({ x, z, size, turn = 0 }) => {
  const rock = createRock(size >= 0.5)
  rock.scale.setScalar(size * rockScale)
  rock.rotation.set((rockRandom() - 0.5) * 0.2, rockRandom() * Math.PI * 2 + turn, (rockRandom() - 0.5) * 0.2)
  // Sink each rock partly into the ground so it looks settled, not placed on top
  rock.position.set(x, getGroundHeight(x, z) + size * rockScale * 0.15, z)
  setShadows(rock, true, true)
  scene.add(rock)
  return rock
})

// Rock footprints: each rock's outline seen from above, the convex hull of all its
// vertices projected onto the ground. Grass is kept just outside this outline (instead of
// a rough circle), so blades grow right up to the stone on every side without poking
// through it, and the ground mask and the blade skirt below follow the real shape
const convexHull2D = (points) => {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  upper.pop()
  lower.pop()
  // Counter-clockwise in (x, z)
  return lower.concat(upper)
}

const rockFootprints = rocks.map((rock) => {
  rock.updateMatrixWorld(true)
  const points = []
  const vertex = new THREE.Vector3()
  rock.traverse((child) => {
    if (!child.isMesh) return
    const positions = child.geometry.attributes.position
    for (let i = 0; i < positions.count; i++) {
      vertex.fromBufferAttribute(positions, i).applyMatrix4(child.matrixWorld)
      points.push([vertex.x, vertex.z])
    }
  })
  const hull = convexHull2D(points)
  const centerX = hull.reduce((sum, p) => sum + p[0], 0) / hull.length
  const centerZ = hull.reduce((sum, p) => sum + p[1], 0) / hull.length
  const radius = Math.max(...hull.map((p) => Math.hypot(p[0] - centerX, p[1] - centerZ)))
  let perimeter = 0
  hull.forEach((p, i) => {
    const q = hull[(i + 1) % hull.length]
    perimeter += Math.hypot(q[0] - p[0], q[1] - p[1])
  })
  // How far out from the edge the lusher grass around this rock reaches
  const reach = 0.8 + radius * 0.8
  return { hull, centerX, centerZ, radius, perimeter, reach }
})

// Signed distance from a ground point to a footprint's edge: negative inside the rock
const footprintDistance = (footprint, x, z) => {
  const { hull, centerX, centerZ, radius } = footprint
  const roughDistance = Math.hypot(x - centerX, z - centerZ) - radius
  if (roughDistance > 1.5) return roughDistance
  let nearest = Infinity
  let inside = true
  for (let i = 0; i < hull.length; i++) {
    const [ax, az] = hull[i]
    const [bx, bz] = hull[(i + 1) % hull.length]
    const ex = bx - ax
    const ez = bz - az
    if (ex * (z - az) - ez * (x - ax) < 0) inside = false
    const t = THREE.MathUtils.clamp(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez), 0, 1)
    nearest = Math.min(nearest, Math.hypot(x - (ax + ex * t), z - (az + ez * t)))
  }
  return inside ? -nearest : nearest
}

// Distance to the nearest rock edge (negative inside a rock)
const distanceToRocks = (x, z) => {
  let nearest = Infinity
  for (const footprint of rockFootprints) nearest = Math.min(nearest, footprintDistance(footprint, x, z))
  return nearest
}

// 0-1: how strongly a point is in the grassy surround of a rock. Full at the edge (and
// under the rock), easing out to nothing at the rock's reach. Noise stretches and shrinks
// the reach from place to place, so the surround has a ragged edge that merges into the
// field's own patches instead of making round islands
const rockSurround = (x, z) => {
  const reachScale = 0.6 + 0.8 * THREE.MathUtils.clamp(noise.noise(x * 0.9, z * 0.9, 41.3) + 0.5, 0, 1)
  let surround = 0
  for (const footprint of rockFootprints) {
    const distance = Math.max(footprintDistance(footprint, x, z), 0)
    surround = Math.max(surround, 1 - THREE.MathUtils.smoothstep(distance, 0, footprint.reach * reachScale))
  }
  return surround
}

// 0-1: how central a point is. Full across the middle of the terrain, fading out toward
// the edges, with a noisy, ragged boundary so the covered area doesn't read as a circle
const centerSurround = (x, z) => {
  const wobble = 1 + 0.35 * noise.noise(x * 0.25, z * 0.25, 57.1)
  return 1 - THREE.MathUtils.smoothstep(Math.hypot(x, z) * wobble, 4.5, 8.5)
}

// Height factor for blades near a rock: grass right at the stone stays low and hugs its
// base, so the rock stands clear of the turf as in the reference, and grows back to full
// height over a short distance
const rockHugHeight = (distance) => THREE.MathUtils.lerp(0.5, 1, THREE.MathUtils.smoothstep(distance, 0.03, 0.45))

// The first ground map is built now that the rock outlines exist, into both slots
for (const _ of buildGroundMapRows(groundMapData));
previousGroundMapData.set(groundMapData)
groundMap.needsUpdate = true
previousGroundMap.needsUpdate = true


// Grass: straight, pointed blades drawn in a single call with an InstancedMesh.
// bladeCount is the budget at full density; sparse ground ends up with fewer. On top of
// those, rockSkirtCount extra blades crowd around the rock bases (see below)
const bladeCount = 60000
const rockSkirtCount = 6000
const candidateCount = bladeCount + rockSkirtCount
const bladeWidth = 0.05
const bladeHeight = 0.3

// Each blade is a flat triangle: wide at the base, sharp at the tip. Pivot sits at the base.
// The same triangle is split into a few rows along its height so the wind can curve it
// smoothly; the outline is unchanged, it just has vertices in between to bend
const bladeSegments = 5
const bladeVertices = []
const bladeIndices = []

for (let i = 0; i < bladeSegments; i++) {
  const t = i / bladeSegments
  const halfWidth = (bladeWidth / 2) * (1 - t)
  bladeVertices.push(-halfWidth, t * bladeHeight, 0, halfWidth, t * bladeHeight, 0)
}
bladeVertices.push(0, bladeHeight, 0)

for (let i = 0; i < bladeSegments - 1; i++) {
  const left = i * 2
  const right = left + 1
  bladeIndices.push(left, right, left + 2, right, right + 2, left + 2)
}
const tipIndex = bladeSegments * 2
bladeIndices.push(tipIndex - 2, tipIndex - 1, tipIndex)

const bladeGeometry = new THREE.BufferGeometry()
bladeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(bladeVertices, 3))
bladeGeometry.setIndex(bladeIndices)
bladeGeometry.computeVertexNormals()

// Wind: one shared, procedural wind field that every blade samples at its own root
// position in world space, so neighbors move together and gusts roll across the field.
// Tweak these (or use the panel in the top-right corner) to change the atmosphere
const windSettings = {
  // Maximum bend of the tip, in radians
  strength: 0.33,
  // How fast the waves travel, in world units per second
  speed: 0.4,
  // Waves per world unit: higher means shorter distance between successive waves
  frequency: 0.85,
  // Direction the gusts travel across the ground, in degrees (0 = +x, 90 = +z)
  direction: 35,
  // How unsettled the wind is (0-1): gusts swelling and fading in patches, uneven
  // wave fronts, and a little per-blade flutter. 0 gives a smooth, steady wave
  turbulence: 0.55,
}

// Uniforms shared by reference with the blade shader; the animation loop only updates values.
// Speed and direction aren't uniforms: the loop integrates them into how far the wind has
// travelled (uWindDrift) and how far the waves have rolled (uWavePhase). Computing
// direction * speed * time in the shader instead would make any change to speed or
// direction jump the whole pattern by an amount that grows with time
const windUniforms = {
  uTime: { value: 0 },
  uWindStrength: { value: windSettings.strength },
  uWindFrequency: { value: windSettings.frequency },
  uWindDirection: { value: new THREE.Vector2() },
  uWindTurbulence: { value: windSettings.turbulence },
  uWindDrift: { value: new THREE.Vector2() },
  uWavePhase: { value: 0 },
}

// The panel sets targets; the loop eases toward them (see updateWind)
const windTargets = {}
const windState = { speed: windSettings.speed, direction: windSettings.direction }

const applyWindSettings = () => {
  windTargets.uWindStrength = windSettings.strength
  windTargets.uWindFrequency = windSettings.frequency
  windTargets.uWindTurbulence = windSettings.turbulence
}
applyWindSettings()

const updateWind = (delta, alpha) => {
  easeUniforms(windUniforms, windTargets, alpha)
  windState.speed += (windSettings.speed - windState.speed) * alpha
  // Turn the short way round, so 350 -> 10 degrees swings through 0, not back through 180
  const turn = THREE.MathUtils.euclideanModulo(windSettings.direction - windState.direction + 180, 360) - 180
  windState.direction += turn * alpha

  const angle = THREE.MathUtils.degToRad(windState.direction)
  const direction = windUniforms.uWindDirection.value.set(Math.cos(angle), Math.sin(angle))
  windUniforms.uWindDrift.value.addScaledVector(direction, windState.speed * delta)
  windUniforms.uWavePhase.value = (windUniforms.uWavePhase.value + windState.speed * windUniforms.uWindFrequency.value * Math.PI * 2 * delta) % (Math.PI * 2)
}
updateWind(0, 1)

// Wind field GLSL shared by everything that sways (grass blades and flowers), so the
// whole field moves as one
const windShader = /* glsl */ `
  uniform float uTime;
  uniform vec2 uWindDirection;
  uniform vec2 uWindDrift;
  uniform float uWavePhase;
  uniform float uWindFrequency;
  uniform float uWindStrength;
  uniform float uWindTurbulence;

  float windHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float windNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(windHash(i), windHash(i + vec2(1.0, 0.0)), u.x),
      mix(windHash(i + vec2(0.0, 1.0)), windHash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  // Rotation of angle radians around a unit axis
  mat3 windRotation(vec3 axis, float angle) {
    float s = sin(angle);
    float c = cos(angle);
    float oc = 1.0 - c;
    return mat3(
      oc * axis.x * axis.x + c, oc * axis.x * axis.y + axis.z * s, oc * axis.z * axis.x - axis.y * s,
      oc * axis.x * axis.y - axis.z * s, oc * axis.y * axis.y + c, oc * axis.y * axis.z + axis.x * s,
      oc * axis.z * axis.x + axis.y * s, oc * axis.y * axis.z - axis.x * s, oc * axis.z * axis.z + c
    );
  }

  // The shared wind field at a point on the ground (world xz). Returns the horizontal
  // direction blades lean in (xy) and how far their tips bend, in radians (z).
  //
  // It is worked out as a lean vector, so blades sway forward and back and a little to
  // the sides rather than only leaning downwind by more or less:
  // - The direction wanders: slowly over time, and across the field in broad regions, so
  //   no part of the field keeps one fixed lean
  // - Three waves at different scales, angles and speeds roll downwind and overlap, each
  //   warped by slow noise, so fronts bulge and lag and different areas move at different
  //   times. Their phases are whole multiples of the smoothly integrated wave phase, so
  //   changing speed or direction never makes them jump
  // - Broad gust patches drift with the flow, and a slow cross-wind sway rides on top
  // - uWindStrength scales the whole field: it is the largest bend, in radians
  vec3 sampleWind(vec2 p) {
    // Coordinates that move with the wind, so patterns travel instead of flickering
    vec2 drift = p - uWindDrift;

    float wander = (windNoise(vec2(uTime * 0.021, 3.1)) - 0.5) * 0.9 + (windNoise(drift * 0.045 + vec2(41.0, uTime * 0.017)) - 0.5) * 1.1;
    float wanderAngle = wander * (0.3 + uWindTurbulence);
    vec2 baseDirection = normalize(uWindDirection);
    float c = cos(wanderAngle);
    float s = sin(wanderAngle);
    vec2 direction = vec2(baseDirection.x * c - baseDirection.y * s, baseDirection.x * s + baseDirection.y * c);
    vec2 side = vec2(-direction.y, direction.x);

    float warp = (windNoise(drift * 0.15 + vec2(3.7, uTime * 0.03)) - 0.5) * uWindTurbulence * 6.0;
    float f = uWindFrequency * 6.2832;
    vec2 direction2 = direction * 0.94 + side * 0.34;
    vec2 direction3 = direction * 0.88 - side * 0.47;
    float wave = sin(dot(p, direction) * f - uWavePhase + warp) * 0.55
      + sin(dot(p, direction2) * f * 1.7 - uWavePhase * 2.0 + warp * 0.7 + 1.3) * 0.3
      + sin(dot(p, direction3) * f * 2.9 - uWavePhase * 3.0 - warp * 0.5 + 4.1) * 0.15;

    // Gusts: broad patches of stronger and weaker wind
    float gust = smoothstep(0.1, 0.9, windNoise(drift * 0.08 + vec2(17.0, uTime * 0.05)));
    gust = mix(1.0, 0.3 + gust * 0.7, uWindTurbulence);

    // Lean along the wind: a gentle average lean, with the waves swinging blades well
    // forward and a little back past upright. Plus a slow sideways sway
    float alongWind = 0.38 + 0.5 * wave;
    float crossWind = (windNoise(drift * 0.35 + vec2(uTime * 0.22, 7.7)) - 0.5) * (0.35 + 0.5 * uWindTurbulence);
    vec2 lean = (direction * alongWind + side * crossWind) * uWindStrength * gust;

    float bend = length(lean);
    return vec3(bend > 1e-5 ? lean / bend : direction, bend);
  }
`

// Gradient: the base of each blade matches the ground, then blends into the grass
// color toward the tip. Blade bases disappear into the surface, so the gaps between
// blades read as grass too and the field looks much denser than the blade count
const bladeMaterial = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide })
bladeMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uBladeHeight = { value: bladeHeight }
  Object.assign(shader.uniforms, windUniforms, groundUniforms, lightingUniforms)

  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
      ${groundMapShader}
      varying float vGrassAmount;
      varying float vDryAmount;
      varying vec3 vBaseColor;
      varying float vBladeRandom;
      uniform float uBladeHeight;
      ${windShader}
      attribute vec3 aGroundNormal;
      attribute float aDensityRank;
      varying float vBladeHeight;
      varying vec3 vGroundNormal;`
    )
    // The wind is worked out before the normals are transformed so the same bend can
    // be applied to both the normal (here) and the position (in begin_vertex below)
    .replace(
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
      // Blade's local-to-world rotation and scale, and its root on the ground
      mat3 bladeBasis = mat3(modelMatrix) * mat3(instanceMatrix);
      mat3 bladeBasisInverse = inverse(bladeBasis);
      vec3 bladeRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

      // Each blade samples the shared field a little upwind of its root, so a passing wave
      // reaches neighbors at slightly different moments while they still move as one
      float bladeRandom = windHash(bladeRoot.xz);
      vec3 wind = sampleWind(bladeRoot.xz - normalize(uWindDirection) * (bladeRandom - 0.5) * 0.35);

      // One ground map sample at the root drives this blade's height and colors, using the
      // same mask that decided whether it grows here at all
      vec4 groundSample = sampleGroundMap(bladeRoot.xz);
      float grass = grassAmount(groundSample.r);
      vGrassAmount = grass;
      vDryAmount = dryAmount(groundSample, grass);
      vBaseColor = groundColor(groundSample);
      vBladeRandom = bladeRandom;

      // Height: short on bare ground, tall in lush grass. A slow noise plus a per-blade
      // random keep blades with the same mask value from lining up into flat height bands
      float heightPatch = windNoise(bladeRoot.xz * 1.7 + 53.0) - 0.5;
      float heightBlend = clamp(grass + heightPatch * 0.5 * uHeightVariation, 0.0, 1.0);
      float bladeLength = mix(uHeightMin, uHeightMax, heightBlend);
      bladeLength *= 1.0 + (windHash(bladeRoot.xz + 17.3) - 0.5) * uHeightVariation;
      float bladeLengthScale = bladeLength / uBladeHeight;

      // Density, continuously: each blade has a fixed random rank and grows wherever the
      // local density is above it. As density changes, blades rise out of or sink into the
      // ground over a short range instead of popping. The mask view folds the field away
      float bladeGrowth = smoothstep(aDensityRank - 0.04, aDensityRank, grassDensity(grass));
      bladeGrowth *= 1.0 - uShowMask;
      bladeLengthScale *= bladeGrowth;

      // How much this blade gives: a little more or less than its neighbors, and a little
      // more for tall blades (their tips also travel further for the same bend)
      float bladeResponse = (0.82 + 0.36 * windHash(bladeRoot.xz + 5.9)) * mix(0.88, 1.12, heightBlend);
      float windAngle = clamp(wind.z * bladeResponse, 0.0, 1.2);
      // Secondary sway of the tip: a slow, smooth wobble at the blade's own pace, mostly
      // along the wind, scaled by the wind strength
      float tipSway = (windNoise(vec2(uTime * (1.1 + bladeRandom * 0.8), bladeRandom * 91.7)) - 0.5) * uWindStrength * (0.35 + 0.4 * uWindTurbulence);

      // Bend around a horizontal axis across the wind, pivoting at the root: positive
      // angles tip the blade downwind. Each vertex turns by an amount that grows with its
      // height squared, so the base stays planted and the blade curves toward the tip.
      // Rotating (rather than sliding) keeps every point's distance from the root, so the
      // blade never stretches
      vec3 windAxis = vec3(wind.y, 0.0, -wind.x);
      float windMask = clamp(position.y / uBladeHeight, 0.0, 1.0);
      mat3 windBend = windRotation(windAxis, windAngle * windMask * windMask + tipSway * windMask * windMask * windMask);

      objectNormal = transpose(bladeBasis) * (windBend * (transpose(bladeBasisInverse) * objectNormal));`
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vBladeHeight = position.y / uBladeHeight;
      vGroundNormal = normalize((viewMatrix * vec4(aGroundNormal, 0.0)).xyz);
      // Stretch from the root (y = 0) so the base stays planted; the flat blade's normal
      // is unaffected. The wind below rotates, so it bends long and short blades alike
      transformed.y *= bladeLengthScale;
      transformed.x *= uBladeWidth * bladeGrowth;
      // Bend in world space, then go back to the blade's local space so the instance and
      // model transforms that follow place it exactly as before
      transformed = bladeBasisInverse * (windBend * (bladeBasis * transformed));`
    )

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      ${groundMapShader}
      varying float vBladeHeight;
      varying vec3 vGroundNormal;
      varying float vGrassAmount;
      varying float vDryAmount;
      varying vec3 vBaseColor;
      varying float vBladeRandom;
      uniform float uGrassTranslucency;`
    )
    // Color: healthy blades keep their own green (times the tint), drier ones fade to
    // straw, and on thin ground they take on the soil color so stray tufts sit in the
    // dirt. Then the ground color under the root at the base, blade color at the tip
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      vec3 bladeColor = diffuseColor.rgb * uGrassTint;
      vec3 strawColor = uDryColor * (0.8 + 0.4 * vBladeRandom);
      bladeColor = mix(bladeColor, strawColor, vDryAmount);
      bladeColor = mix(bladeColor, vBaseColor, (1.0 - vGrassAmount) * uSoilTint);
      float bladeGradient = smoothstep(0.15, 1.0, vBladeHeight);
      diffuseColor.rgb = mix(vBaseColor, bladeColor, bladeGradient);`
    )
    // Lighting: the blade sides face sideways while the ground faces along its own
    // slope, so the same color would still shade differently. At the base, use the
    // exact ground normal under the blade so the base is lit exactly like the surface,
    // then blend toward the blade's own normal further up
    .replace(
      '#include <normal_fragment_begin>',
      `#include <normal_fragment_begin>
      normal = normalize(mix(vGroundNormal, normal, bladeGradient * 0.4));`
    )
    // Translucency: thin blades glow when the sun is behind them. Taken from the sun light
    // itself (its view-space direction, color and shadow map), so it follows the sun, and
    // blades in a tree's shade don't glow.
    // - Backlight: view-dependent forward scattering, a tight bright lobe looking straight
    //   into the sun plus a wider, weaker one, and a little wherever the sun lights the
    //   blade's far side. Looking away from the sun it is zero, so the field never glows
    //   on its own
    // - Thin tips pass the most light: the glow builds gradually up the blade and is
    //   strongest at the tip
    // - The light that comes through stays in the blade's own green: its color lifted
    //   toward a pale version of the same hue, as sunlight filtered through thin leaf
    //   tissue. It takes the sun's brightness but only a little of its hue, so a low,
    //   orange sun doesn't turn the tips orange
    // - The added light rolls off smoothly, scaled equally in every channel, so bright tips
    //   never clip (clipping maxes out green first and skews the color toward yellow-white)
    .replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      #if NUM_DIR_LIGHTS > 0
        vec3 toSun = directionalLights[0].direction;
        float facing = saturate(dot(toSun, -geometryViewDir));
        float through = 1.2 * pow(facing, 12.0) + 0.18 * pow(facing, 3.0) + 0.12 * saturate(dot(-normal, toSun));
        float tip = bladeGradient * (0.15 + 0.85 * smoothstep(0.3, 1.0, vBladeHeight));
        float sunShadow = 1.0;
        #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
          sunShadow = receiveShadow ? getShadow(directionalShadowMap[0], directionalLightShadows[0].shadowMapSize, directionalLightShadows[0].shadowIntensity, directionalLightShadows[0].shadowBias, directionalLightShadows[0].shadowRadius, vDirectionalShadowCoord[0]) : 1.0;
        #endif
        vec3 sunColor = directionalLights[0].color;
        float sunLevel = dot(sunColor, vec3(0.2126, 0.7152, 0.0722));
        vec3 sunLight = mix(vec3(sunLevel), sunColor, 0.2);
        // Pale green: the blade's hue at full brightness, softened a little toward white
        vec3 bladeHue = diffuseColor.rgb / max(max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b)), 1e-3);
        vec3 paleGreen = mix(bladeHue, vec3(1.0), 0.3) * 0.5;
        vec3 transmitted = mix(diffuseColor.rgb, paleGreen, 0.55);
        vec3 glow = sunLight * transmitted * through * tip * sunShadow * uGrassTranslucency;
        float glowPeak = max(glow.r, max(glow.g, glow.b));
        glow *= glowPeak > 1e-4 ? 0.5 * (1.0 - exp(-glowPeak / 0.5)) / glowPeak : 1.0;
        reflectedLight.directDiffuse += glow;
      #endif`
    )
}

const blades = new THREE.InstancedMesh(bladeGeometry, bladeMaterial, candidateCount)

// Area-weighted placement: pick a ground triangle with probability proportional to its
// area, then a random point inside it. Larger (e.g. steeper) triangles get more blades
// and smaller ones fewer, so density follows real surface area rather than how finely
// one part of the mesh happens to be subdivided
const groundIndex = groundGeometry.index
const triangle = new THREE.Triangle()
const triangleAreas = []
let totalArea = 0

for (let i = 0; i < groundIndex.count; i += 3) {
  triangle.setFromAttributeAndIndices(
    groundPositions,
    groundIndex.getX(i),
    groundIndex.getX(i + 1),
    groundIndex.getX(i + 2)
  )
  totalArea += triangle.getArea()
  // Running total, so a random value in [0, totalArea) maps to one triangle
  triangleAreas.push(totalArea)
}

const pickTriangle = () => {
  const target = Math.random() * totalArea

  // Binary search for the first triangle whose running total passes the target
  let low = 0
  let high = triangleAreas.length - 1
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (triangleAreas[mid] < target) low = mid + 1
    else high = mid
  }

  return low
}

const pointA = new THREE.Vector3()
const pointB = new THREE.Vector3()
const pointC = new THREE.Vector3()

const normalA = new THREE.Vector3()
const normalB = new THREE.Vector3()
const normalC = new THREE.Vector3()
const groundNormal = new THREE.Vector3()

// Random point inside the triangle, plus the ground's smooth normal at that exact point
const randomPointInTriangle = (target, targetNormal) => {
  // Square root keeps points uniform across the triangle instead of bunching at a corner
  const r1 = Math.sqrt(Math.random())
  const r2 = Math.random()
  const weightA = 1 - r1
  const weightB = r1 * (1 - r2)
  const weightC = r1 * r2

  targetNormal
    .copy(normalA).multiplyScalar(weightA)
    .addScaledVector(normalB, weightB)
    .addScaledVector(normalC, weightC)
    .normalize()

  return target
    .copy(pointA).multiplyScalar(weightA)
    .addScaledVector(pointB, weightB)
    .addScaledVector(pointC, weightC)
}

const bladeDummy = new THREE.Object3D()
const bladeColor = new THREE.Color()
const groundNormals = groundGeometry.attributes.normal
const bladeGroundNormals = new Float32Array(candidateCount * 3)

// Each blade carries the ground normal under it, used to light its base like the surface
const bladeGroundNormalAttribute = new THREE.InstancedBufferAttribute(bladeGroundNormals, 3)
bladeGeometry.setAttribute('aGroundNormal', bladeGroundNormalAttribute)

// Random spot on the ground, outside the rocks so blades don't poke through the stones
const pickGrassSpot = () => {
  let underRock = true
  while (underRock) {
    const face = pickTriangle() * 3
    pointA.fromBufferAttribute(groundPositions, groundIndex.getX(face))
    pointB.fromBufferAttribute(groundPositions, groundIndex.getX(face + 1))
    pointC.fromBufferAttribute(groundPositions, groundIndex.getX(face + 2))
    normalA.fromBufferAttribute(groundNormals, groundIndex.getX(face))
    normalB.fromBufferAttribute(groundNormals, groundIndex.getX(face + 1))
    normalC.fromBufferAttribute(groundNormals, groundIndex.getX(face + 2))

    randomPointInTriangle(bladeDummy.position, groundNormal)

    // A small gap keeps a blade's slight lean from tipping it into the stone
    underRock = distanceToRocks(bladeDummy.position.x, bladeDummy.position.z) < 0.035
  }
}

// Density from the ground mask. bladeCount candidate spots are laid out once, each with a
// fixed random rank in 0-1; a blade grows wherever the local density is above its rank,
// so on average a fraction `density` of spots have grass, from sparseDensity on bare soil
// up to all of them in lush grass. Because ranks never change, density settings can be
// eased continuously in the shader with blades growing and shrinking in place
const candidateMatrices = new Float32Array(candidateCount * 16)
const candidateColors = new Float32Array(candidateCount * 3)
const candidateNormals = new Float32Array(candidateCount * 3)
const candidateRanks = new Float32Array(candidateCount)
const candidateX = new Float32Array(candidateCount)
const candidateZ = new Float32Array(candidateCount)
// Mask under each candidate, in the previous and current ground maps (see the crossfade)
const candidatePreviousMask = new Float32Array(candidateCount)
const candidateMask = new Float32Array(candidateCount)

for (let i = 0; i < bladeCount; i++) {
  pickGrassSpot()
  candidateX[i] = bladeDummy.position.x
  candidateZ[i] = bladeDummy.position.z
  candidateRanks[i] = Math.random()

  // Face any direction, with a slight random lean so blades cross each other
  bladeDummy.rotation.set(
    (Math.random() - 0.5) * 0.4,
    Math.random() * Math.PI * 2,
    (Math.random() - 0.5) * 0.4
  )
  // x: width. Height is left at 1 (the shader sets it from the ground mask), except near
  // rocks, where blades shorten toward the stone like the skirt around it
  bladeDummy.scale.set(0.7 + Math.random() * 0.6, rockHugHeight(distanceToRocks(candidateX[i], candidateZ[i])), 1)
  bladeDummy.updateMatrix()
  bladeDummy.matrix.toArray(candidateMatrices, i * 16)
  groundNormal.toArray(candidateNormals, i * 3)

  // Rich yellow-green tones from the reference, varied a little per blade
  bladeColor.setHSL(0.23 + Math.random() * 0.025, 0.95, 0.3 + Math.random() * 0.07)
  bladeColor.toArray(candidateColors, i * 3)
}

// Rock skirts: extra blades crowding the base of every rock, as in the reference. They're
// spread along each outline in proportion to its length, packed tightest right at the
// stone and thinning out over a short distance. Near the edge they're taller and lean
// away from the rock, as grass does where it grows up against a stone; farther out they
// settle into the field's usual height and lean. They join the same candidate pool as
// the field blades, so the ground mask, density transitions, wind and shadows all apply
// to them unchanged
const totalRockPerimeter = rockFootprints.reduce((sum, footprint) => sum + footprint.perimeter, 0)
const skirtYaw = new THREE.Quaternion()
const skirtLean = new THREE.Quaternion()
const skirtAxis = new THREE.Vector3()
const upAxis = new THREE.Vector3(0, 1, 0)

for (let i = bladeCount; i < candidateCount; i++) {
  let x, z, outX, outZ, closeness
  for (;;) {
    // Random point along a random rock's outline (rocks weighted by outline length)
    let along = Math.random() * totalRockPerimeter
    let footprint = rockFootprints[rockFootprints.length - 1]
    for (const candidate of rockFootprints) {
      if (along <= candidate.perimeter) {
        footprint = candidate
        break
      }
      along -= candidate.perimeter
    }
    const { hull } = footprint
    let edge = 0
    let edgeLength = 0
    for (; edge < hull.length; edge++) {
      const p = hull[edge]
      const q = hull[(edge + 1) % hull.length]
      edgeLength = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (along <= edgeLength || edge === hull.length - 1) break
      along -= edgeLength
    }
    const [ax, az] = hull[edge]
    const [bx, bz] = hull[(edge + 1) % hull.length]
    const length = Math.max(edgeLength, 1e-6)
    const t = THREE.MathUtils.clamp(along / length, 0, 1)
    const edgeX = ax + (bx - ax) * t
    const edgeZ = az + (bz - az) * t
    // Outward from the rock: the edge normal of a counter-clockwise outline
    outX = (bz - az) / length
    outZ = -(bx - ax) / length
    // Most blades right at the stone, fewer farther out
    const maxDistance = 0.18 + footprint.radius * 0.45
    const distance = 0.035 + Math.pow(Math.random(), 1.8) * maxDistance
    closeness = 1 - (distance - 0.035) / maxDistance
    const sideways = (Math.random() - 0.5) * 0.06
    x = edgeX + outX * distance - outZ * sideways
    z = edgeZ + outZ * distance + outX * sideways
    if (Math.abs(x) > groundSize / 2 || Math.abs(z) > groundSize / 2) continue
    // Stay clear of every rock, including neighbors
    if (distanceToRocks(x, z) >= 0.035) break
  }

  candidateX[i] = x
  candidateZ[i] = z
  candidateRanks[i] = Math.random()

  // Ground normal from the slope around the spot
  const e = 0.2
  groundNormal
    .set(getGroundHeight(x - e, z) - getGroundHeight(x + e, z), 2 * e, getGroundHeight(x, z - e) - getGroundHeight(x, z + e))
    .normalize()

  // Any heading; tipped away from the rock, more so close to it, plus a little randomness.
  // Turning about (up x outward) tips a blade's top outward
  skirtYaw.setFromAxisAngle(upAxis, Math.random() * Math.PI * 2)
  skirtAxis.set(outX, 0, outZ)
  skirtAxis.crossVectors(upAxis, skirtAxis).normalize()
  skirtLean.setFromAxisAngle(skirtAxis, (0.08 + 0.32 * closeness) * (0.5 + Math.random() * 0.5) + (Math.random() - 0.5) * 0.15)
  bladeDummy.position.set(x, getGroundHeight(x, z), z)
  bladeDummy.quaternion.copy(skirtLean).multiply(skirtYaw)
  // Width varies like the field; height is lower right at the stone, with plenty of
  // variation so the skirt reads as uneven tufts rather than a trimmed edge
  bladeDummy.scale.set(0.7 + Math.random() * 0.6, rockHugHeight(distanceToRocks(x, z)) * (0.75 + Math.random() * 0.5), 1)
  bladeDummy.updateMatrix()
  bladeDummy.matrix.toArray(candidateMatrices, i * 16)
  groundNormal.toArray(candidateNormals, i * 3)

  bladeColor.setHSL(0.23 + Math.random() * 0.025, 0.95, 0.3 + Math.random() * 0.07)
  bladeColor.toArray(candidateColors, i * 3)
}

blades.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(candidateCount * 3), 3)
const bladeRankAttribute = new THREE.InstancedBufferAttribute(new Float32Array(candidateCount), 1)
bladeGeometry.setAttribute('aDensityRank', bladeRankAttribute)

// Bounds of every candidate: a superset of whatever is drawn, so it never needs redoing
blades.instanceMatrix.array.set(candidateMatrices)
blades.computeBoundingSphere()

// The threshold, softness and sparse density uniforms ease toward these, like the others
const densityTargets = {}
const applyDensitySettings = () => {
  densityTargets.uGrassThreshold = groundSettings.threshold
  densityTargets.uGrassSoftness = groundSettings.softness
  densityTargets.uSparseDensity = groundSettings.sparseDensity
}
applyDensitySettings()
easeUniforms(groundUniforms, densityTargets, 1)

// Blades whose rank is this far above the density are fully sunk (matches the shader's
// growth ramp, plus a little room for 8-bit filtering differences)
const densityMargin = 0.05

// Only candidates that can actually show are written into the instance buffer, so sparse
// ground really draws fewer blades. While something is transitioning, a candidate is kept
// if it shows at any point on the way from now to the target, so blades are already in
// place to grow in or still there to shrink away; once settled, the list is trimmed to
// the target alone. The settings move in a straight line from now to the target, and the
// mask from the current crossfade blend toward 1; density only rises with the mask, so
// checking both mask ends at a few points along the settings line covers the whole path
const densityPathSteps = [0, 1 / 3, 2 / 3, 1]
const densityPath = densityPathSteps.map(() => ({ threshold: 0, softness: 0, sparse: 0 }))

const compactBlades = () => {
  const u = groundUniforms
  const t = densityTargets
  densityPathSteps.forEach((step, k) => {
    const lerp = THREE.MathUtils.lerp
    densityPath[k].threshold = lerp(u.uGrassThreshold.value, t.uGrassThreshold, step)
    densityPath[k].softness = lerp(u.uGrassSoftness.value, t.uGrassSoftness, step)
    densityPath[k].sparse = lerp(u.uSparseDensity.value, t.uSparseDensity, step)
  })
  const blend = mapFade.value
  const matrices = blades.instanceMatrix.array
  const colors = blades.instanceColor.array
  const normals = bladeGroundNormalAttribute.array
  const ranks = bladeRankAttribute.array
  let placed = 0

  for (let i = 0; i < candidateCount; i++) {
    const shownMask = candidatePreviousMask[i] + (candidateMask[i] - candidatePreviousMask[i]) * blend
    const highMask = Math.max(shownMask, candidateMask[i])
    let density = 0
    for (const step of densityPath) {
      density = Math.max(density, grassDensity(highMask, step.threshold, step.softness, step.sparse))
    }
    if (candidateRanks[i] >= density + densityMargin) continue

    for (let k = 0; k < 16; k++) matrices[placed * 16 + k] = candidateMatrices[i * 16 + k]
    for (let k = 0; k < 3; k++) {
      colors[placed * 3 + k] = candidateColors[i * 3 + k]
      normals[placed * 3 + k] = candidateNormals[i * 3 + k]
    }
    ranks[placed] = candidateRanks[i]
    placed++
  }

  blades.count = placed
  // Upload only the part of each buffer in use
  for (const attribute of [blades.instanceMatrix, blades.instanceColor, bladeGroundNormalAttribute, bladeRankAttribute]) {
    attribute.clearUpdateRanges()
    attribute.addUpdateRange(0, placed * attribute.itemSize)
    attribute.needsUpdate = true
  }
}

// Instance list upkeep, driven from the animation loop. Rebuilding costs a few ms, so it
// runs at most every `interval` seconds while things move, plus once when they settle
const densityUpdate = { dirty: true, settling: false, cooldown: 0, interval: 0.1 }

const isDensitySettling = () => {
  if (mapFade.value < 1) return true
  for (const name in densityTargets) {
    if (Math.abs(groundUniforms[name].value - densityTargets[name]) > 1e-3) return true
  }
  return false
}

// Mask under every candidate in the starting map (later maps sample it while building)
for (let i = 0; i < candidateCount; i++) {
  candidateMask[i] = sampleGrassMask(candidateX[i], candidateZ[i], groundMapData)
}
candidatePreviousMask.set(candidateMask)

// Returns how far density-related values may ease this frame. While the instance list is
// out of date they hold still, so no blade is asked to grow before it's in the list
const updateDensity = (delta, alpha) => {
  densityUpdate.cooldown -= delta
  const settling = isDensitySettling()
  if (densityUpdate.settling && !settling) densityUpdate.dirty = true
  densityUpdate.settling = settling

  if ((densityUpdate.dirty || settling) && densityUpdate.cooldown <= 0) {
    compactBlades()
    densityUpdate.dirty = false
    densityUpdate.cooldown = densityUpdate.interval
  }

  const densityAlpha = densityUpdate.dirty ? 0 : alpha
  easeUniforms(groundUniforms, densityTargets, densityAlpha)
  return densityAlpha
}
updateDensity(0, 1)
// Blades receive shade but never cast it: they sway every frame, which would make a frozen
// shadow wrong (and a live one flicker), and 60k casters would cost a lot for little gain.
// Their shaders are patched MeshStandardMaterials, so the shadow lookup is built in, and
// it uses each vertex's swayed position, so a bent blade picks up the shade where it is
blades.receiveShadow = true
scene.add(blades)

// Flowers: daisy-like heads on thin, forked stems with a few leaves, growing in small
// clumps through the grass.
//
// Plants, as in the reference: one stalk rises from the ground with a gentle S-curve,
// thicker at the base, and around halfway up it forks: the main flower carries on and one
// or more side flowers branch off, arching outward and then up. Small oval leaves with
// pointed tips sit on the main stalk, one low near the base and one around the fork, on
// alternating sides and angled upward.
//
// Each flower is one instance of a tiny mesh (stem ribbon, head, two leaves). Every flower
// of a plant shares the plant's root, trunk curve and wind, so their stems coincide
// exactly up to the fork and read as one stalk that splits. The stem ribbon always turns
// toward the camera (it never vanishes edge-on), heads face roughly toward the viewer,
// tipped up a little, and petals and leaves are drawn in the fragment shader. The wind is
// the grass's shared field, sampled once at the root: the stalk bends more and more
// toward the top while the base stays planted, and heads and leaves ride along
//
// Types, from the references: big purple daisies (side shoots are often buds), forked
// sprays of peach-orange ones, small pink ones and short indigo ones. Colors are albedos
// chosen so the rendered petals, stems and leaves match the reference under this scene's
// lighting
const flowerTypes = [
  { weight: 0.25, petals: [8, 10], roundness: 0.55, petal: '#7e6eae', center: '#6a5c96', size: [0.07, 0.085], plants: [1, 3], heads: [1, 2], spread: 0.3, budChance: 0.6 },
  { weight: 0.3, petals: [9, 11], roundness: 0.5, petal: '#b79648', center: '#8c6a2c', size: [0.055, 0.07], plants: [1, 2], heads: [2, 3], spread: 0.15, budChance: 0 },
  { weight: 0.2, petals: [6, 8], roundness: 0.45, petal: '#c391c2', center: '#9a6a98', size: [0.042, 0.056], plants: [1, 2], heads: [2, 4], spread: 0.18, budChance: 0.2 },
  { weight: 0.25, petals: [8, 9], roundness: 0.55, petal: '#7c70ad', center: '#5c548a', size: [0.034, 0.044], plants: [1, 3], heads: [1, 2], spread: 0.25, budChance: 0 },
  // Seed heads (kind 2 and 3): a golden, feathery plume of chevron spikelets on a tall
  // stalk that rises well above the grass, and a slim lavender spike of small bead-like
  // florets at about grass height. size is the head's half-width, spikeLength its length
  // in half-widths, petals the spikelet / floret rows, stalk the stalk height
  { weight: 0.16, kind: 2, petals: [9, 12], spikeLength: [5.5, 6.5], petal: '#ffe496', center: '#dcb862', size: [0.03, 0.036], stalk: [0.62, 0.85], plants: [1, 3], heads: [1, 1], spread: 0.25, budChance: 0 },
  { weight: 0.14, kind: 3, petals: [11, 14], spikeLength: [9, 11], petal: '#dca4e0', center: '#a2749f', size: [0.014, 0.018], stalk: [0.42, 0.58], plants: [2, 4], heads: [1, 1], spread: 0.2, budChance: 0 },
]
const flowerClumpCount = 450
// Stalk length (root to main head) in head diameters: about 2.5-3 in the reference
const flowerStalkLength = [2.5, 3]

const flowerSettings = { amount: 0.8, size: 1, height: 1, stemColor: '#4f8a1e', leafColor: '#437d18' }
const flowerUniforms = {
  uFlowerAmount: { value: flowerSettings.amount },
  uFlowerSize: { value: flowerSettings.size },
  uFlowerHeight: { value: flowerSettings.height },
  uFlowerStemColor: { value: new THREE.Color() },
  uFlowerLeafColor: { value: new THREE.Color() },
}
const flowerTargets = { uFlowerStemColor: new THREE.Color(), uFlowerLeafColor: new THREE.Color() }
const applyFlowerSettings = () => {
  flowerTargets.uFlowerAmount = flowerSettings.amount
  flowerTargets.uFlowerSize = flowerSettings.size
  flowerTargets.uFlowerHeight = flowerSettings.height
  flowerTargets.uFlowerStemColor.set(flowerSettings.stemColor)
  flowerTargets.uFlowerLeafColor.set(flowerSettings.leafColor)
}
applyFlowerSettings()
easeUniforms(flowerUniforms, flowerTargets, 1)

// Shared mesh. position encodes what each vertex is, and the shader builds the real shape:
//   stem: x = side of the ribbon (-1 / 1), y = 0 at the root to 1 at the head, z = 0
//   head: x, y = corner of the head square (-1 / 1), z = 1
//   leaf: x = across the leaf (-1 / 1), y = 0 at the stem to 1 at the tip, z = 2 (low) / 3
const flowerStemSegments = 12
const flowerPositions = []
const flowerIndices = []
for (let i = 0; i <= flowerStemSegments; i++) {
  const t = i / flowerStemSegments
  flowerPositions.push(-1, t, 0, 1, t, 0)
  if (i < flowerStemSegments) {
    const a = i * 2
    flowerIndices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
}
const addFlowerQuad = (corners, z) => {
  const start = flowerPositions.length / 3
  for (const [x, y] of corners) flowerPositions.push(x, y, z)
  flowerIndices.push(start, start + 1, start + 2, start, start + 2, start + 3)
}
addFlowerQuad([[-1, -1], [1, -1], [1, 1], [-1, 1]], 1)
addFlowerQuad([[-1, 0], [1, 0], [1, 1], [-1, 1]], 2)
addFlowerQuad([[-1, 0], [1, 0], [1, 1], [-1, 1]], 3)

const flowerGeometry = new THREE.BufferGeometry()
flowerGeometry.setAttribute('position', new THREE.Float32BufferAttribute(flowerPositions, 3))
// Placeholder normals; the shader replaces them
flowerGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(flowerPositions.length).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3))
flowerGeometry.setIndex(flowerIndices)
// The real shape is built in the shader, so give the bounds of the tallest possible plant
flowerGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 1)

// Per-flower data
const flowerMatrices = []
const flowerPetalColors = []
const flowerCenterColors = []
const flowerShapes = []
const flowerStems = []
const flowerCurves = []
const flowerBranches = []
const flowerLeaves = []
const flowerExtras = []
const flowerColor = new THREE.Color()
const flowerMatrix = new THREE.Matrix4()
const pickRange = ([min, max]) => min + Math.random() * (max - min)
const randomAngle = () => Math.random() * Math.PI * 2
const totalTypeWeight = flowerTypes.reduce((sum, type) => sum + type.weight, 0)

const addFlower = (type, root, plant, flower) => {
  flowerMatrix.makeTranslation(root.x, root.y, root.z)
  flowerMatrices.push(...flowerMatrix.elements)

  flowerColor.set(type.petal).offsetHSL((Math.random() - 0.5) * 0.02, 0, (Math.random() - 0.5) * 0.06)
  flowerPetalColors.push(flowerColor.r, flowerColor.g, flowerColor.b)
  flowerColor.set(type.center)
  flowerCenterColors.push(flowerColor.r, flowerColor.g, flowerColor.b)
  // petal count, petal roundness, rotation of the petal ring, open flower (0), bud (1),
  // golden plume (2) or lavender spike (3)
  // (for seed heads: rows, length in half-widths, unused, kind)
  flowerShapes.push(
    Math.round(pickRange(type.petals)),
    type.kind ? pickRange(type.spikeLength) : type.roundness,
    randomAngle(),
    type.kind ?? (flower.isBud ? 1 : 0)
  )
  // this flower's stem length, its head radius, the plant's height, the fork height
  flowerStems.push(flower.length, flower.radius, plant.height, plant.forkHeight)
  // trunk: direction and size of its bow, direction and size of its lean (fractions of
  // the plant height). Together they give the gentle S-curve
  flowerCurves.push(plant.bowAngle, plant.bow, plant.leanAngle, plant.lean)
  // after the fork: direction this flower's stem heads off in, and how far it spreads
  flowerBranches.push(flower.branchAngle, flower.branchSpread, 0, 0)
  // leaves (main stem only): heights as fractions of the plant height, and lengths
  flowerLeaves.push(...flower.leaves)
  // rank (shared by the plant, for the amount control), turn away from facing the
  // camera, upward tilt of the head, the plant's random number (shared, so the whole
  // plant nods together)
  flowerExtras.push(plant.rank, (Math.random() - 0.5) * 1.2, 0.15 + Math.random() * 0.45, plant.random)
}

// The extra clumps (one per rock) sit just off a rock's edge, as in the reference
for (let c = 0; c < flowerClumpCount + rockFootprints.length; c++) {
  let pick = Math.random() * totalTypeWeight
  const type = flowerTypes.find((candidate) => (pick -= candidate.weight) < 0) ?? flowerTypes[0]

  let centerX, centerZ
  if (c < flowerClumpCount) {
    pickGrassSpot()
    centerX = bladeDummy.position.x
    centerZ = bladeDummy.position.z
  } else {
    const footprint = rockFootprints[c - flowerClumpCount]
    const angle = randomAngle()
    const distance = footprint.radius + 0.12 + Math.random() * 0.2
    centerX = footprint.centerX + Math.cos(angle) * distance
    centerZ = footprint.centerZ + Math.sin(angle) * distance
  }
  const plantCount = Math.round(pickRange(type.plants))

  for (let p = 0; p < plantCount; p++) {
    const angle = randomAngle()
    const distance = Math.sqrt(Math.random()) * type.spread
    const x = THREE.MathUtils.clamp(centerX + Math.cos(angle) * distance, -groundSize / 2, groundSize / 2)
    const z = THREE.MathUtils.clamp(centerZ + Math.sin(angle) * distance, -groundSize / 2, groundSize / 2)
    if (distanceToRocks(x, z) < 0.06) continue
    const root = new THREE.Vector3(x, getGroundHeight(x, z), z)

    const radius = pickRange(type.size)
    const height = type.kind ? pickRange(type.stalk) : radius * 2 * pickRange(flowerStalkLength)
    // Bow and lean point roughly opposite ways, which makes the S
    const bowAngle = randomAngle()
    const plant = {
      height,
      forkHeight: height * (0.45 + Math.random() * 0.15),
      bowAngle,
      bow: 0.05 + Math.random() * 0.05,
      leanAngle: bowAngle + Math.PI + (Math.random() - 0.5) * 1.2,
      lean: 0.1 + Math.random() * 0.12,
      rank: Math.random(),
      random: Math.random(),
    }

    // Main flower: carries on above the fork with only a slight kink, and holds the leaves
    const mainBranch = randomAngle()
    const leafSide = Math.random() < 0.5 ? 1 : -1
    addFlower(type, root, plant, {
      length: height,
      radius,
      isBud: false,
      branchAngle: mainBranch,
      branchSpread: 0.1,
      // low leaf (wider, oval) and fork leaf (narrower), on alternating sides: the sign
      // of the length carries the side
      leaves: type.kind
        ? [0, 0, 0, 0]
        : [
            0.12 + Math.random() * 0.1,
            plant.forkHeight / height - 0.04 + Math.random() * 0.06,
            leafSide * radius * (0.85 + Math.random() * 0.2),
            -leafSide * radius * (0.95 + Math.random() * 0.2),
          ],
    })

    // Side flowers: branch off at the fork, away from the main flower, shorter and smaller
    const sideCount = Math.round(pickRange(type.heads)) - 1
    for (let h = 0; h < sideCount; h++) {
      const isBud = Math.random() < type.budChance
      addFlower(type, root, plant, {
        length: height * (0.72 + Math.random() * 0.16),
        radius: radius * (isBud ? 0.5 : 0.75 + Math.random() * 0.15),
        isBud,
        branchAngle: mainBranch + Math.PI + (h - (sideCount - 1) / 2) * 1.3 + (Math.random() - 0.5) * 0.6,
        branchSpread: 0.4 + Math.random() * 0.2,
        leaves: [0, 0, 0, 0],
      })
    }
  }
}

const flowerCount = flowerMatrices.length / 16
const addFlowerAttribute = (name, values, size) =>
  flowerGeometry.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(values), size))
addFlowerAttribute('aPetalColor', flowerPetalColors, 3)
addFlowerAttribute('aCenterColor', flowerCenterColors, 3)
addFlowerAttribute('aShape', flowerShapes, 4)
addFlowerAttribute('aStem', flowerStems, 4)
addFlowerAttribute('aCurve', flowerCurves, 4)
addFlowerAttribute('aBranch', flowerBranches, 4)
addFlowerAttribute('aLeaf', flowerLeaves, 4)
addFlowerAttribute('aFlower', flowerExtras, 4)

const flowerMaterial = new THREE.MeshStandardMaterial({
  side: THREE.DoubleSide,
  // Petal and leaf edges are soft: their alpha becomes MSAA coverage, not a hard cutout
  alphaToCoverage: true,
  alphaTest: 0.01,
})
flowerMaterial.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, windUniforms, groundUniforms, flowerUniforms)

  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
      ${groundMapShader}
      ${windShader}
      uniform float uFlowerAmount;
      uniform float uFlowerSize;
      uniform float uFlowerHeight;
      attribute vec3 aPetalColor;
      attribute vec3 aCenterColor;
      attribute vec4 aShape;
      attribute vec4 aStem;
      attribute vec4 aCurve;
      attribute vec4 aBranch;
      attribute vec4 aLeaf;
      attribute vec4 aFlower;
      varying vec2 vFlowerUv;
      varying float vFlowerPart;
      varying float vStemT;
      varying vec3 vPetalColor;
      varying vec3 vCenterColor;
      varying vec4 vShape;
      varying vec3 vFlowerBase;
      varying float vPlantRandom;
      varying float vStemAlong;

      // The plant's shape, set at the top of main()
      float plantHeight;
      float forkHeight;
      vec3 bowDirection;
      vec3 leanDirection;
      vec3 branchDirection;
      vec3 plantWindAxis;
      float plantWind;

      vec3 horizontal(float angle) {
        return vec3(cos(angle), 0.0, sin(angle));
      }

      // Stem centerline at height y above the root, before the wind. The trunk bows one
      // way and leans the other (a gentle S); above the fork each flower's stem arches
      // out in its own direction and then turns back up toward its head
      vec3 plantCurve(float y) {
        float k = y / plantHeight;
        vec3 trunk = bowDirection * aCurve.y * plantHeight * sin(2.83 * k)
          + leanDirection * aCurve.w * plantHeight * k * k;
        float branch = max(y - forkHeight, 0.0) / plantHeight;
        vec3 spread = branchDirection * aBranch.y * plantHeight * (branch - 0.6 * branch * branch);
        return vec3(0.0, y, 0.0) + trunk + spread;
      }

      // The same point after the wind: the whole plant turns about its root, by an amount
      // that grows with height squared, so the base stays put and the top bends most
      vec3 plantPoint(float y) {
        float k = y / plantHeight;
        return windRotation(plantWindAxis, plantWind * k * k) * plantCurve(y);
      }

      vec3 plantTangent(float y, float maxY) {
        float delta = plantHeight * 0.02;
        float a = clamp(y - delta, 0.0, maxY);
        float b = clamp(y + delta, 0.0, maxY);
        return normalize(plantPoint(b) - plantPoint(a) + vec3(0.0, 1e-6, 0.0));
      }`
    )
    .replace(
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
      vec3 flowerRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

      // Flowers only bloom in healthy grass: they shrink into the ground where the mask
      // turns to soil, and grow back as it greens, following the same smooth transitions.
      // Growth only depends on the root and the plant's rank, so a plant grows as one
      vec4 groundSample = sampleGroundMap(flowerRoot.xz);
      float flowerGrowth = smoothstep(0.55, 0.9, grassAmount(groundSample.r));
      flowerGrowth *= smoothstep(aFlower.x, aFlower.x + 0.05, uFlowerAmount * 1.05);
      flowerGrowth *= 1.0 - uShowMask;
      float heightScale = uFlowerHeight * flowerGrowth;
      float stemLength = aStem.x * heightScale;
      float headSize = aStem.y * uFlowerSize * flowerGrowth;
      plantHeight = max(aStem.z * heightScale, 1e-4);
      forkHeight = aStem.w * heightScale;
      bowDirection = horizontal(aCurve.x);
      leanDirection = horizontal(aCurve.z);
      branchDirection = horizontal(aBranch.x);

      // The grass's wind field, sampled at the root. Stalks are a little stiffer than
      // blades, and each plant adds a slow nod of its own
      vec3 wind = sampleWind(flowerRoot.xz);
      float plantRandom = aFlower.w;
      plantWind = wind.z * 0.8 + sin(uTime * (1.6 + plantRandom) + plantRandom * 6.2832) * 0.04 * (0.3 + uWindTurbulence);
      plantWind = clamp(plantWind, -0.3, 1.1);
      plantWindAxis = vec3(wind.y, 0.0, -wind.x);

      float part = position.z;
      vec3 flowerOffset;
      vec3 toCamera;

      if (part < 0.5) {
        // Stem: a ribbon along the centerline, turned toward the camera. Width follows
        // the reference: about 1/18 of the head's width, tapering from the base, and a
        // little thinner again above the fork. It depends only on the plant and the
        // height, so stems sharing the trunk match exactly
        float y = position.y * stemLength;
        vec3 point = plantPoint(y);
        toCamera = cameraPosition - (flowerRoot + point);
        vec3 tangent = plantTangent(y, stemLength);
        vec3 side = normalize(cross(tangent, toCamera));
        float width = plantHeight * mix(0.014, 0.0085, y / plantHeight);
        width *= mix(1.0, 0.8, smoothstep(forkHeight, forkHeight + plantHeight * 0.05, y));
        flowerOffset = point + side * position.x * width;
        objectNormal = normalize(normalize(cross(side, tangent)) + vec3(0.0, 1.0, 0.0));
        vStemT = y / plantHeight;
      } else if (part < 1.5) {
        // Head: faces the viewer's side (turned a little per flower) and tips upward,
        // then leans over with the bent stem tip
        vec3 top = plantPoint(stemLength);
        toCamera = cameraPosition - (flowerRoot + top);
        vec3 tangent = plantTangent(stemLength, stemLength);
        if (aShape.w > 1.5) {
          // Seed head: carries straight on from the stalk's tip, along its bent direction,
          // so it nods with the wind; flat toward the camera like the stalk
          vec3 headRight = normalize(cross(tangent, toCamera));
          float headLength = headSize * aShape.y;
          vec3 headCenter = top + tangent * headLength * 0.5;
          flowerOffset = headCenter + headRight * position.x * headSize + tangent * position.y * headLength * 0.5;
          vec3 headNormal = normalize(cross(headRight, tangent));
          headNormal *= sign(dot(headNormal, toCamera));
          objectNormal = normalize(headNormal + vec3(0.0, 0.8, 0.0));
        } else {
          vec2 face = normalize(toCamera.xz + vec2(1e-5));
          float turn = aFlower.y;
          face = vec2(cos(turn) * face.x - sin(turn) * face.y, sin(turn) * face.x + cos(turn) * face.y);
          float tilt = aFlower.z;
          vec3 facing = vec3(face.x * cos(tilt), sin(tilt), face.y * cos(tilt));
          float topBend = stemLength / plantHeight;
          facing = windRotation(plantWindAxis, plantWind * topBend * topBend) * facing;
          vec3 headRight = normalize(cross(vec3(0.0, 1.0, 0.0), facing));
          vec3 headUp = cross(facing, headRight);
          vec3 headCenter = top + tangent * headSize * 0.2;
          flowerOffset = headCenter + (headRight * position.x + headUp * position.y) * headSize;
          // Lit as a soft, mostly sky-facing surface so heads don't go dark when turned away
          objectNormal = normalize(facing + vec3(0.0, 0.8, 0.0));
        }
        vStemT = 1.0;
      } else {
        // Leaf: attached at its narrow base to the main stem, pointing outward to one
        // side and angled upward, flat toward the camera like the stem it grows on. Its
        // own small flutter rides on top of the stem's bend
        bool lowLeaf = part < 2.5;
        float leafHeight = (lowLeaf ? aLeaf.x : aLeaf.y) * plantHeight;
        float leafLength = (lowLeaf ? aLeaf.z : aLeaf.w) * uFlowerSize * flowerGrowth;
        float leafSide = sign(leafLength);
        leafLength = abs(leafLength);
        // The low leaf is a broader oval, the upper one narrower, as in the reference
        float leafWidth = leafLength * (lowLeaf ? 0.6 : 0.42);

        vec3 attach = plantPoint(leafHeight);
        toCamera = cameraPosition - (flowerRoot + attach);
        vec3 tangent = plantTangent(leafHeight, stemLength);
        vec3 outward = normalize(cross(tangent, toCamera)) * leafSide;
        float flutter = sin(uTime * (2.3 + plantRandom * 1.7) + leafHeight * 40.0) * 0.08 * (0.3 + wind.z);
        float rise = 0.6 + plantRandom * 0.25 + flutter;
        vec3 leafDirection = normalize(outward * cos(rise) + tangent * sin(rise));
        vec3 leafAcross = normalize(cross(leafDirection, toCamera));
        flowerOffset = attach + leafDirection * position.y * leafLength + leafAcross * position.x * leafWidth * 0.5;
        objectNormal = normalize(normalize(cross(leafAcross, leafDirection)) * sign(dot(cross(leafAcross, leafDirection), toCamera)) + vec3(0.0, 0.8, 0.0));
        vStemT = leafHeight / plantHeight;
      }

      vFlowerUv = position.xy;
      vFlowerPart = part;
      vPetalColor = aPetalColor;
      vCenterColor = aCenterColor;
      vShape = aShape;
      vFlowerBase = groundColor(groundSample);
      vPlantRandom = aFlower.w;
      // How far along this flower's own stem (0 root, 1 just under the head)
      vStemAlong = part < 0.5 ? position.y : 1.0;`
    )
    .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = flowerOffset;')

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      uniform vec3 uFlowerStemColor;
      uniform vec3 uFlowerLeafColor;
      varying vec2 vFlowerUv;
      varying float vFlowerPart;
      varying float vStemT;
      varying vec3 vPetalColor;
      varying vec3 vCenterColor;
      varying vec4 vShape;
      varying vec3 vFlowerBase;
      varying float vPlantRandom;
      varying float vStemAlong;

      // Each plant's own stem green: a little lighter or darker, a little warmer or cooler
      vec3 plantStemColor() {
        vec3 color = uFlowerStemColor * mix(0.82, 1.12, vPlantRandom);
        return mix(color, color * vec3(1.12, 1.02, 0.75), fract(vPlantRandom * 7.31) * 0.6);
      }`
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      if (vFlowerPart < 0.5) {
        // Stem: a dark grass-green that varies from plant to plant, slightly darker low
        // down in the grass, warming and lightening just under the flower so the stem
        // runs into the head instead of stopping at it, and fading into the ground color
        // right where it enters the soil
        vec3 stemColor = plantStemColor() * mix(0.88, 1.06, clamp(vStemT, 0.0, 1.0));
        stemColor = mix(stemColor, stemColor * vec3(1.18, 1.12, 0.85), smoothstep(0.86, 1.0, vStemAlong));
        diffuseColor.rgb = mix(vFlowerBase, stemColor, smoothstep(0.0, 0.06, vStemT));
      } else if (vFlowerPart < 1.5) {
        vec2 uv = vFlowerUv;
        float edge;
        vec3 headColor;

        if (vShape.w > 2.5) {
          // Lavender spike: small round florets stacked up the axis, alternating left and
          // right, shrinking toward the top. Each floret is darker at its rim, so the
          // spike reads as a column of separate beads
          float t = uv.y * 0.5 + 0.5;
          float rows = vShape.x;
          float cell = t * rows;
          float row = floor(cell);
          // One row's height, in the same units as the width (uv.x)
          float rowHeight = 2.0 * vShape.y / rows;
          edge = -1e3;
          float beadRim = 1.0;
          for (int k = -1; k <= 1; k++) {
            float r = row + float(k);
            float rowT = (r + 0.5) / rows;
            float size = mix(1.0, 0.45, rowT) * smoothstep(0.0, 0.08, rowT) * step(rowT, 1.0);
            float across = (mod(r, 2.0) < 0.5 ? -0.32 : 0.32) * size;
            vec2 q = vec2(uv.x - across, (cell - (r + 0.5)) * rowHeight);
            float radius = 0.62 * size;
            float beadEdge = radius - length(q);
            if (beadEdge > edge) {
              edge = beadEdge;
              beadRim = length(q) / max(radius, 1e-3);
            }
          }
          headColor = mix(vPetalColor, vCenterColor, smoothstep(0.35, 1.0, beadRim));
          headColor *= mix(0.85, 1.05, t);
        } else if (vShape.w > 1.5) {
          // Golden plume, like a feather: a narrow core with large, sharp teeth on both
          // sides (offset from each other), each widening outward to a point that sweeps
          // up toward the tip. Full through the middle, narrowing to a point at the top
          // and to the stalk at the bottom. Flat pale gold as in the reference, only a
          // little deeper in the notches, along the core and at the base where it meets
          // the stalk
          float t = uv.y * 0.5 + 0.5;
          float rows = vShape.x;
          float body = pow(sin(3.14159 * pow(clamp(t, 0.0, 1.0), 0.75)), 0.5);
          float side = uv.x < 0.0 ? 0.0 : 0.5;
          float spikelet = fract(t * rows + side - abs(uv.x) * 1.3);
          // Each tooth widens steadily over most of its row, then ends in a sharp point
          float tooth = smoothstep(0.0, 0.9, spikelet);
          edge = body * mix(0.42, 1.0, tooth) - abs(uv.x);
          headColor = mix(vPetalColor, vCenterColor, (1.0 - tooth) * 0.15);
          headColor = mix(headColor, vCenterColor, (1.0 - smoothstep(0.0, 0.12, abs(uv.x))) * 0.3);
          headColor = mix(vCenterColor * 0.85, headColor, smoothstep(0.0, 0.18, t));
        } else if (vShape.w > 0.5) {
          // Bud: a closed teardrop, darker at the base
          vec2 q = uv * vec2(1.7, 1.0) + vec2(0.0, 0.15);
          q.x *= 1.0 + 0.35 * clamp(uv.y, 0.0, 1.0);
          edge = 0.85 - length(q);
          headColor = mix(vCenterColor, vPetalColor, smoothstep(-0.8, 0.6, uv.y));
        } else {
          // Open flower: a ring of rounded petals with small notches between them, around
          // a darker center. Petals are shaded darker toward the middle and the gaps
          float r = length(uv);
          float sector = 6.2832 / vShape.x;
          float local = mod(atan(uv.y, uv.x) + vShape.z, sector) - sector * 0.5;
          float lobe = cos(local / sector * 3.14159);
          float petalEdge = mix(0.3, 1.0, pow(max(lobe, 0.0), vShape.y));
          edge = petalEdge - r;

          float centerRadius = 0.3;
          float center = 1.0 - smoothstep(centerRadius - 0.05, centerRadius, r);
          float petalShade = mix(0.86, 1.03, smoothstep(centerRadius, 0.95, r)) * mix(0.9, 1.0, lobe);
          vec3 centerColor = vCenterColor * mix(0.8, 1.0, smoothstep(0.0, centerRadius, r));
          headColor = mix(vPetalColor * petalShade, centerColor, center);
        }

        diffuseColor.rgb = headColor;
        // Anti-aliased silhouette: about one pixel of soft edge at any distance
        diffuseColor.a = clamp(edge / max(fwidth(edge), 1e-4) + 0.5, 0.0, 1.0);
      } else {
        // Leaf: an oval with a pointed tip, narrowing to the stem at its base. Flat dark
        // green, slightly lighter along the middle and darker at the rim and base
        vec2 uv = vFlowerUv;
        float along = clamp(uv.y, 0.0, 1.0);
        float halfWidth = pow(sin(3.14159 * pow(along, 1.15)), 0.65);
        float edge = halfWidth - abs(uv.x);
        // Starts in the stem's own color where it joins the stem, then becomes leaf green
        vec3 leafColor = uFlowerLeafColor * mix(0.85, 1.12, vPlantRandom) * mix(0.9, 1.04, smoothstep(0.0, 0.45, along));
        leafColor = mix(plantStemColor(), leafColor, smoothstep(0.0, 0.3, along));
        leafColor *= mix(0.9, 1.06, 1.0 - smoothstep(0.0, 0.7, abs(uv.x) / max(halfWidth, 1e-3)));
        diffuseColor.rgb = leafColor;
        diffuseColor.a = clamp(edge / max(fwidth(edge), 1e-4) + 0.5, 0.0, 1.0);
      }`
    )
    // Double-sided, but the shader's normals are already right from both sides
    .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);')
}

const flowers = new THREE.InstancedMesh(flowerGeometry, flowerMaterial, flowerCount)
flowers.instanceMatrix.array.set(flowerMatrices)
flowers.instanceMatrix.needsUpdate = true
flowers.computeBoundingSphere()
// Flowers, like the grass, sway: they receive shade but don't cast it
flowers.receiveShadow = true
scene.add(flowers)

// Trees: eight Japanese black pines at fixed spots (see pines.js): crooked, tapering
// trunks with procedural plate-and-fissure bark, irregular windswept branches, and open
// pads of fine needle tufts. All the wood is one mesh and all the needles one instanced
// mesh: two draw calls for the stand. Both use the standard lit material, so they follow
// the sun, its shadows and the god rays
const pines = createBlackPines(getGroundHeight)
// The wood and needles cast into the frozen shadow map (they never move) and receive it,
// so upper pads shade lower ones and the trunks, and dappled shade falls on the grass
setShadows(pines.wood, true, true)
pines.needles.castShadow = true
pines.needles.receiveShadow = true
scene.add(pines.wood, pines.needles)

// Sky: a large dome drawn behind everything, with a blue gradient (lighter overhead,
// deeper blue toward the horizon), the sun, and the volumetric clouds (see clouds.js).
// The clouds are ray-marched into a separate, lower-resolution texture each frame; the
// dome lays them over the gradient by screen position: sky * transmittance + cloud light.
// Everything in the scene is far nearer than the clouds, so the depth test alone keeps
// terrain, trees and grass in front of them, and the clouds cover the sun disc like any
// other part of the sky
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(90, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      // Bright, light cyan overhead and a clear sky blue toward and below the horizon
      uSkyTop: { value: new THREE.Color('#b6ecff') },
      uSkyHorizon: { value: new THREE.Color('#62bcee') },
      uSunDirection: { value: new THREE.Vector3() },
      uSunColor: { value: new THREE.Color() },
      // Cosine of the sun disc's angular radius (set from the panel's disc size)
      uSunCos: { value: Math.cos(THREE.MathUtils.degToRad(1.1)) },
      uClouds: { value: null },
      uViewport: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDirection;

      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSkyTop;
      uniform vec3 uSkyHorizon;
      uniform vec3 uSunDirection;
      uniform vec3 uSunColor;
      uniform float uSunCos;
      uniform sampler2D uClouds;
      uniform vec2 uViewport;
      varying vec3 vDirection;

      void main() {
        vec3 direction = normalize(vDirection);
        float height = direction.y;

        // Lightens quickly above the horizon, reaching the light cyan by about 20 degrees up
        vec3 color = mix(uSkyHorizon, uSkyTop, smoothstep(-0.08, 0.36, height));

        // Sun: a small bright disc in a soft glow, following the scene's light
        float toSun = max(dot(direction, uSunDirection), 0.0);
        vec3 sun = uSunColor * (0.12 * pow(toSun, 10.0) + 0.3 * pow(toSun, 220.0) + 3.0 * smoothstep(uSunCos - (1.0 - uSunCos) * 0.6, uSunCos, toSun));

        // Clouds (upsampled by the bilinear filter): rgb is the light they send toward the
        // camera, alpha how much of the sky behind still shows through. The sun is so much
        // brighter than the sky that it still glows through thin and partial cloud, so it is
        // dimmed much less (transmittance to the power 0.3): only thick cloud hides it
        vec4 clouds = texture2D(uClouds, gl_FragCoord.xy / uViewport);
        color = color * clouds.a + sun * pow(clouds.a, 0.3) + clouds.rgb;

        // Sunlit cloud tops and the sun are brighter than the display can show: roll the
        // highlights off smoothly instead of clipping them flat
        vec3 over = max(color - 0.8, 0.0);
        color = min(color, 0.8) + 0.2 * (1.0 - exp(-over / 0.2));

        gl_FragColor = vec4(color, 1.0);
        // Colors are in linear space like the rest of the scene; convert for display
        #include <colorspace_fragment>
      }
    `,
  })
)
// Draw first, behind everything else
sky.renderOrder = -1
scene.add(sky)

// Every control below only sets a target. The animation loop eases the scene toward the
// targets each frame (exponential damping on delta time, so the feel is the same at any
// frame rate): `speed` is how quickly, roughly 1 / seconds to cover most of the way
const transition = { speed: 8 }

// The panel (styled in style.css): a frosted glass panel at the top right, in sections. Grass
// holds the key field controls with the rest in sub-groups, then Terrain, Flowers, and
// Lighting & atmosphere (sun, shading, god rays and clouds)
const gui = new GUI({ title: 'Controls' })

// Performance, first in the panel. Adaptive quality watches the frame rate and, while it
// stays low, steps down the render resolution and the cloud quality (never above what the
// panel asks for), stepping back up once there is room again. Show FPS puts a small frame
// rate readout in the top left corner. Both run from the animation loop (see
// updatePerformance), from the same frame timing
const performanceSettings = { adaptive: true, showFps: false }
const performanceFolder = gui.addFolder('Grass Performance')
const qualityFolder = performanceFolder.addFolder('Quality')
qualityFolder.add(performanceSettings, 'adaptive').name('Adaptive quality').onChange(() => setQualityLevel(performanceSettings.adaptive ? qualityLevel : 0))
qualityFolder.add(performanceSettings, 'showFps').name('Show FPS').onChange(() => {
  fpsMeter.hidden = !performanceSettings.showFps
})
gui.add(transition, 'speed', 2, 20, 0.5).name('transition speed')
// Back to the starting view (see cameraStart)
gui.add({ resetCamera: () => controls.reset() }, 'resetCamera').name('reset camera')

// Grass controls. Colors, heights and density settings ease in place; map settings
// rebuild the map in the background and crossfade it in, so every slider can be dragged
// freely and the field follows
const groundFolder = gui.addFolder('Grass')
groundFolder.add(windSettings, 'strength', 0, 1.2, 0.01).name('wind strength').onChange(applyWindSettings)

const applyDistributionSettings = () => {
  applyDensitySettings()
  densityUpdate.dirty = true
}

groundFolder
  .add(biomeState, 'biome', Object.keys(biomePresets))
  .name('biome preset')
  .onChange((biome) => {
    Object.assign(groundSettings, biomePresets[biome])
    applyGroundSettings()
    applyDistributionSettings()
    requestGroundMap()
    gui.controllersRecursive().forEach((controller) => controller.updateDisplay())
  })

// Black and white view of the mask on the ground, for tuning the distribution. The grass
// sinks into the ground as the mask fades in
const maskView = { show: new URLSearchParams(window.location.search).has('mask') }
const maskTargets = {}
const applyMaskView = () => {
  maskTargets.uShowMask = maskView.show ? 1 : 0
}
applyMaskView()
easeUniforms(groundUniforms, maskTargets, 1)
groundFolder.add(groundSettings, 'mapDetail', 0.3, 0.75, 0.01).name('edge detail').onChange(requestGroundMap)
groundFolder.add(groundSettings, 'mapContrast', 0.3, 3, 0.05).name('patch contrast').onChange(requestGroundMap)
groundFolder.add(maskView, 'show').name('show mask').onChange(applyMaskView)

// Wind controls (strength is above, with the key grass controls)
const windFolder = groundFolder.addFolder('Wind')
windFolder.add(windSettings, 'speed', 0, 6, 0.05).onChange(applyWindSettings)
windFolder.add(windSettings, 'frequency', 0.05, 1.5, 0.01).onChange(applyWindSettings)
windFolder.add(windSettings, 'direction', 0, 360, 1).onChange(applyWindSettings)
windFolder.add(windSettings, 'turbulence', 0, 1, 0.01).onChange(applyWindSettings)

const distributionFolder = groundFolder.addFolder('Distribution')
distributionFolder.add(groundSettings, 'mapScale', 0.03, 0.5, 0.005).name('patch frequency').onChange(requestGroundMap)
distributionFolder.add(groundSettings, 'valleyGrass', -1, 1, 0.05).name('valley grass').onChange(requestGroundMap)
distributionFolder.add(groundSettings, 'mapSeed', 0, 100, 1).name('seed').onChange(requestGroundMap)
distributionFolder.add(groundSettings, 'rockGrass', 0, 1, 0.01).name('grass around rocks').onChange(requestGroundMap)
distributionFolder.add(groundSettings, 'centerGrass', 0, 1, 0.01).name('center grass').onChange(requestGroundMap)
distributionFolder.add(groundSettings, 'threshold', 0, 1, 0.01).onChange(applyDistributionSettings)
distributionFolder.add(groundSettings, 'softness', 0.01, 0.5, 0.01).onChange(applyDistributionSettings)
distributionFolder.add(groundSettings, 'sparseDensity', 0, 1, 0.01).name('sparse density').onChange(applyDistributionSettings)

const heightFolder = groundFolder.addFolder('Blade shape')
heightFolder.add(groundSettings, 'heightMin', 0.01, 0.6, 0.01).name('min height').onChange(applyGroundSettings)
heightFolder.add(groundSettings, 'heightMax', 0.05, 1, 0.01).name('max height').onChange(applyGroundSettings)
heightFolder.add(groundSettings, 'heightVariation', 0, 1, 0.01).name('variation').onChange(applyGroundSettings)
heightFolder.add(groundSettings, 'bladeWidth', 0.2, 3, 0.05).name('width').onChange(applyGroundSettings)

const grassColorFolder = groundFolder.addFolder('Grass color')
grassColorFolder.addColor(groundSettings, 'grassTint').name('grass tint').onChange(applyGroundSettings)
grassColorFolder.addColor(groundSettings, 'dryColor').name('dry grass').onChange(applyGroundSettings)
grassColorFolder.add(groundSettings, 'dryness', 0, 1, 0.01).onChange(applyGroundSettings)
grassColorFolder.add(groundSettings, 'biomeVariation', 0, 1, 0.01).name('biome variation').onChange(applyGroundSettings)
grassColorFolder.add(groundSettings, 'sparseDryness', 0, 1, 0.01).name('sparse dryness').onChange(applyGroundSettings)
grassColorFolder.add(groundSettings, 'soilTint', 0, 1, 0.01).name('soil tint').onChange(applyGroundSettings)

// Terrain: the ground's own look
const terrainFolder = gui.addFolder('Terrain')
terrainFolder.add(groundSettings, 'soilGrain', 0, 0.4, 0.01).name('soil grain').onChange(applyGroundSettings)
terrainFolder.addColor(groundSettings, 'turfColor').name('turf').onChange(applyGroundSettings)
terrainFolder.addColor(groundSettings, 'soilColor').name('soil').onChange(applyGroundSettings)
terrainFolder.addColor(groundSettings, 'soilColorAlt').name('soil (alt)').onChange(applyGroundSettings)

for (const folder of [windFolder, distributionFolder, heightFolder, grassColorFolder]) folder.close()
// The panel opens compact, with every section folded, so it covers little of the island
groundFolder.close()
terrainFolder.close()

// Flower controls: amount (share of plants in bloom), head and leaf size, stalk height, colors
const flowerFolder = gui.addFolder('Flowers')
flowerFolder.add(flowerSettings, 'amount', 0, 1, 0.01).onChange(applyFlowerSettings)
flowerFolder.add(flowerSettings, 'size', 0.3, 2.5, 0.05).onChange(applyFlowerSettings)
flowerFolder.add(flowerSettings, 'height', 0.3, 2, 0.05).name('stem height').onChange(applyFlowerSettings)
flowerFolder.addColor(flowerSettings, 'stemColor').name('stem color').onChange(applyFlowerSettings)
flowerFolder.addColor(flowerSettings, 'leafColor').name('leaf color').onChange(applyFlowerSettings)
flowerFolder.close()

// Sun & lighting controls. The sun is the one direct light: its position (elevation in
// degrees above the horizon, azimuth around it: 0 = +x, 90 = +z, as for the wind; it
// starts in line with the rock trail, see sunStart) moves the sun disc, the light, its
// shadows, the grass translucency, the cloud lighting and the god rays together. A
// directional light has no distance, only a direction, so "disc size" is the sun's
// apparent size in the sky.
// Ambient is the even fill light that keeps shade from going black: keep it well below
// the sun. Shadow softness (blur radius, in shadow-map texels) and strength (0 = no shade,
// 1 = full shade) only change how the frozen shadow map is read, so they update live
const lightSettings = {
  sunElevation: sunStart.elevation,
  sunAzimuth: sunStart.azimuth,
  sun: directionalLight.intensity,
  sunColor: '#ffffff',
  discSize: 1.1,
  ambient: ambientLight.intensity,
  shadowSoftness: sunShadow.radius,
  shadowStrength: sunShadow.intensity,
  grassTranslucency: lightingUniforms.uGrassTranslucency.value,
  godRays: 0.6,
  rayLength: 0.9,
}
const lightFolder = gui.addFolder('Lighting & atmosphere')
lightFolder.add(lightSettings, 'sunElevation', 4, 90, 0.5).name('sun elevation')
lightFolder.add(lightSettings, 'sunAzimuth', -180, 180, 1).name('sun azimuth')
lightFolder.add(lightSettings, 'sun', 0, 5, 0.05).name('sun intensity')
lightFolder.addColor(lightSettings, 'sunColor').name('sun color')
lightFolder.add(lightSettings, 'discSize', 0.3, 4, 0.05).name('disc size')
lightFolder.add(lightSettings, 'ambient', 0, 1, 0.01).name('ambient fill')
lightFolder.add(lightSettings, 'shadowSoftness', 0, 12, 0.5).name('shadow softness')
lightFolder.add(lightSettings, 'shadowStrength', 0, 1, 0.01).name('shadow strength')
// Translucency belongs with the key grass controls; it is added here, where its setting
// exists, and moved up to sit after wind strength
const translucencyControl = groundFolder.add(lightSettings, 'grassTranslucency', 0, 1.5, 0.01).name('translucency')
groundFolder.$children.insertBefore(translucencyControl.domElement, groundFolder.controllers[1].domElement)
// The biome preset follows the four key controls, just above "show mask"
const [, biomeControl, , , maskControl] = groundFolder.controllers
groundFolder.$children.insertBefore(biomeControl.domElement, maskControl.domElement)
lightFolder.add(lightSettings, 'godRays', 0, 2, 0.01).name('god rays')
lightFolder.add(lightSettings, 'rayLength', 0.2, 1, 0.01).name('ray length')
lightFolder.close()

// The sun eases toward the panel's settings like everything else. Low sunlight crosses
// more air, so it warms toward orange near the horizon (no change from the starting height
// up), on top of the chosen color. The frozen shadow map is redrawn only while the sun
// moves. `level` is the sun's strength before any cloud passes in front of it, and
// `cloudShade` how much of it currently gets through the clouds to the island
const sunState = {
  elevation: lightSettings.sunElevation,
  azimuth: lightSettings.sunAzimuth,
  level: lightSettings.sun,
  color: new THREE.Color(lightSettings.sunColor),
  discSize: lightSettings.discSize,
  cloudShade: 1,
}
const sunDirection = new THREE.Vector3()
const sunReddening = new THREE.Vector3(0.03, 0.09, 0.22)
const sunColorTarget = new THREE.Color()

const updateSun = (alpha) => {
  const rise = (lightSettings.sunElevation - sunState.elevation) * alpha
  const turn = (THREE.MathUtils.euclideanModulo(lightSettings.sunAzimuth - sunState.azimuth + 180, 360) - 180) * alpha
  sunState.elevation += rise
  sunState.azimuth += turn
  sunState.level += (lightSettings.sun - sunState.level) * alpha
  sunState.color.lerp(sunColorTarget.set(lightSettings.sunColor), alpha)
  sunState.discSize += (lightSettings.discSize - sunState.discSize) * alpha

  const elevation = THREE.MathUtils.degToRad(sunState.elevation)
  const azimuth = THREE.MathUtils.degToRad(sunState.azimuth)
  sunDirection.set(Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth))
  if (Math.abs(rise) + Math.abs(turn) > 1e-4) {
    directionalLight.position.copy(sunDirection).multiplyScalar(30)
    refreshStaticShadows()
  }

  const air = Math.max(1 / Math.max(sunDirection.y, 0.02) - 1.25, 0)
  directionalLight.color
    .setRGB(Math.exp(-sunReddening.x * air), Math.exp(-sunReddening.y * air), Math.exp(-sunReddening.z * air))
    .multiply(sunState.color)

  // The god rays start from the same sun as the disc and the light, at the same size
  godRays.sunDirection.copy(sunDirection)
  const sunCos = Math.cos(THREE.MathUtils.degToRad(sunState.discSize))
  sky.material.uniforms.uSunCos.value = sunCos
  godRays.sunCos = sunCos

  const grass = lightingUniforms.uGrassTranslucency
  grass.value += (lightSettings.grassTranslucency - grass.value) * alpha
  godRays.strength += (lightSettings.godRays - godRays.strength) * alpha
  godRays.length += (lightSettings.rayLength - godRays.length) * alpha
  // Rays take the sun's current color and strength (before cloud shade: the clouds
  // already block them where they cover the sun)
  godRays.sunColor.copy(directionalLight.color).multiplyScalar(sunState.level / 2)
}

// Renderer
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
// Shadows on, softened with PCF filtering (see the light for the radius). Updates stay on
// renderer-wide; the sun's shadow freezes itself (sunShadow.autoUpdate = false)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap
renderer.setSize(sizes.width, sizes.height)
// Render resolution: the screen's pixel ratio (up to 2), times renderScale, which adaptive
// quality lowers when the frame rate drops
const renderScale = { value: 1 }
const applyPixelRatio = () => {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * renderScale.value)
  renderer.getDrawingBufferSize(sky.material.uniforms.uViewport.value)
}
applyPixelRatio()

// Volumetric clouds (see clouds.js and the sky dome). Like every other control, the
// sliders set targets the loop eases toward. Quality sets the march resolution and step
// counts; start on another preset with ?clouds=low (or high, ultra) in the URL
const cloudQuality = new URLSearchParams(window.location.search).get('clouds')
const cloudSettings = {
  quality: cloudQuality in cloudQualityPresets ? cloudQuality : 'medium',
  // Share of the sky covered (0-1), within the patches where clouds form (see clustering).
  // Low by default: a mostly clear sky with sparse fair-weather cumulus
  coverage: 0.3,
  // How strongly clouds gather into scattered groups with wide open sky between them
  // (0 = spread evenly across the sky)
  clustering: 1,
  // Clear sky kept around the sun, in degrees: clouds stay away from it
  sunClearing: 10,
  // Optical thickness: higher is more opaque, with darker undersides
  density: 1,
  // Size of the cloud shapes (1 = large, towering cumulus; the default keeps them small)
  scale: 0.6,
  // Cloud base and depth of the cloud layer, in world units
  height: 220,
  thickness: 180,
  // How strongly fine noise erodes the edges into puffs and wisps (lower is softer)
  detail: 0.8,
  // World units per second, in the wind's direction (Wind folder)
  windSpeed: 6,
  // Direct sunlight and sky light on the clouds
  sunLight: 1,
  ambient: 1,
  // Self-shadowing: how much a cloud's own body darkens its far side and interior
  shadow: 1,
  // Glow of clouds in front of the sun (forward scattering), so they shine rather than
  // smother it
  silverLining: 2.2,
  // How much the sun dims on the island when a cloud passes in front of it. Kept low: a
  // low sun shines through a long stretch of the cloud layer, so it is often covered
  groundShadows: 0.2,
}

const clouds = createVolumetricClouds(renderer, cloudSettings.quality)
clouds.setSize(sizes.width, sizes.height)

// God rays (see godRays.js): the scene is drawn through this pass, which adds the shafts
// of light streaming from the sun and outputs to the canvas
const godRays = createGodRays(renderer)
// The clouds take their ambient light from the sky's own colors
clouds.uniforms.uSkyTop.value = sky.material.uniforms.uSkyTop.value
clouds.uniforms.uSkyHorizon.value = sky.material.uniforms.uSkyHorizon.value
clouds.uniforms.uSunDirection.value = sunDirection
sky.material.uniforms.uSunDirection.value = sunDirection

const cloudTargets = {}
const applyCloudSettings = () => {
  cloudTargets.uCoverage = cloudSettings.coverage
  cloudTargets.uClustering = cloudSettings.clustering
  cloudTargets.uSunClearing = THREE.MathUtils.degToRad(cloudSettings.sunClearing)
  cloudTargets.uDensity = cloudSettings.density
  cloudTargets.uScale = cloudSettings.scale
  cloudTargets.uBase = cloudSettings.height
  cloudTargets.uThickness = cloudSettings.thickness
  cloudTargets.uDetail = cloudSettings.detail
  cloudTargets.uSunLight = cloudSettings.sunLight
  cloudTargets.uAmbientLight = cloudSettings.ambient
  cloudTargets.uShadow = cloudSettings.shadow
  cloudTargets.uSilverLining = cloudSettings.silverLining
}
applyCloudSettings()
easeUniforms(clouds.uniforms, cloudTargets, 1)

const cloudFolder = lightFolder.addFolder('Clouds')
cloudFolder
  .add(cloudSettings, 'quality', Object.keys(cloudQualityPresets))
  .onChange(() => applyQualityLevel())
cloudFolder.add(cloudSettings, 'coverage', 0, 1, 0.01).onChange(applyCloudSettings)
cloudFolder.add(cloudSettings, 'clustering', 0, 1, 0.01).onChange(applyCloudSettings)
cloudFolder.add(cloudSettings, 'sunClearing', 0, 30, 0.5).name('clear around sun').onChange(applyCloudSettings)
cloudFolder.add(cloudSettings, 'density', 0.1, 3, 0.05).onChange(applyCloudSettings)
cloudFolder.add(cloudSettings, 'scale', 0.4, 2.5, 0.05).onChange(applyCloudSettings)
cloudFolder.add(cloudSettings, 'height', 100, 600, 5).name('base height').onChange(applyCloudSettings)
cloudFolder.add(cloudSettings, 'thickness', 50, 400, 5).onChange(applyCloudSettings)
cloudFolder.add(cloudSettings, 'detail', 0, 1.5, 0.01).onChange(applyCloudSettings)
cloudFolder.add(cloudSettings, 'windSpeed', 0, 40, 0.5).name('wind speed')
const cloudLightFolder = cloudFolder.addFolder('Cloud lighting')
cloudLightFolder.add(cloudSettings, 'sunLight', 0, 2.5, 0.05).name('sunlight').onChange(applyCloudSettings)
cloudLightFolder.add(cloudSettings, 'ambient', 0, 2.5, 0.05).name('sky light').onChange(applyCloudSettings)
cloudLightFolder.add(cloudSettings, 'shadow', 0, 2, 0.05).name('self-shadowing').onChange(applyCloudSettings)
cloudLightFolder.add(cloudSettings, 'silverLining', 0, 3, 0.05).name('silver lining').onChange(applyCloudSettings)
cloudLightFolder.add(cloudSettings, 'groundShadows', 0, 1, 0.01).name('ground shadows')
cloudFolder.close()

// Short explanations for the more technical controls, shown on hover
const panelHints = {
  'wind strength': 'Largest bend of the grass in the wind',
  translucency: 'How much sunlight glows through back-lit blades',
  'edge detail': 'How ragged the edges of the grass patches are',
  'patch contrast': 'How sharply grass gives way to bare soil',
  'soil grain': 'How mottled the bare soil is',
  turbulence: 'Gusts, uneven wave fronts and flutter',
  frequency: 'Waves per world unit across the field',
  'god rays': 'Brightness of the sunburst and its beams',
  'ray length': 'How far the beams reach across the screen',
  'shadow softness': 'Blur of the shadow edges',
  'ambient fill': 'Even sky light that keeps shade from going black',
}
gui.controllersRecursive().forEach((controller) => {
  const hint = panelHints[controller._name]
  if (hint) controller.domElement.title = hint
})

// The panel and its sections remember whether they were open (when storage is available)
const panelStateKey = 'gpu-grass-panel'
const panelSections = [gui, ...gui.folders]
try {
  const saved = JSON.parse(localStorage.getItem(panelStateKey) || '{}')
  panelSections.forEach((folder) => {
    if (saved[folder._title] === true) folder.close()
    if (saved[folder._title] === false) folder.open()
  })
} catch {}
const savePanelState = () => {
  try {
    localStorage.setItem(panelStateKey, JSON.stringify(Object.fromEntries(panelSections.map((folder) => [folder._title, folder._closed]))))
  } catch {}
}
panelSections.forEach((folder) => folder.$title.addEventListener('click', () => setTimeout(savePanelState)))

// Wind carries the clouds along the same direction as the gusts in the grass. As with the
// grass, the drift is integrated here, so changing speed or direction never jumps the sky.
// `uEvolve` slowly churns the billows as they travel
const cloudState = { speed: cloudSettings.windSpeed }

const updateClouds = (delta, alpha) => {
  easeUniforms(clouds.uniforms, cloudTargets, alpha)
  cloudState.speed += (cloudSettings.windSpeed - cloudState.speed) * alpha
  const angle = THREE.MathUtils.degToRad(windState.direction)
  const uniforms = clouds.uniforms
  uniforms.uWindOffset.value.x += Math.cos(angle) * cloudState.speed * delta
  uniforms.uWindOffset.value.z += Math.sin(angle) * cloudState.speed * delta
  uniforms.uEvolve.value += (1.5 + cloudState.speed * 0.25) * delta

  // Lit by the scene's sun (its color warms as it sets) and sky. The sky light also
  // fades as the sun gets low
  uniforms.uSunColor.value.copy(directionalLight.color).multiplyScalar(sunState.level / 2)
  sky.material.uniforms.uSunColor.value.copy(uniforms.uSunColor.value)
  // (relative to the default ambient fill of 0.4)
  uniforms.uSkyLight.value = (ambientLight.intensity / 0.4) * THREE.MathUtils.lerp(0.45, 1, THREE.MathUtils.smoothstep(sunDirection.y, 0, 0.5))

  // Cloud shadows on the island: ease slowly, as a cloud's edge sweeps over the ground
  const shade = THREE.MathUtils.lerp(1, clouds.sunVisibility, cloudSettings.groundShadows)
  sunState.cloudShade += (shade - sunState.cloudShade) * (1 - Math.exp(-2 * delta))
}

// Resize
window.addEventListener('resize', () => {
  sizes.width = window.innerWidth
  sizes.height = window.innerHeight

  camera.aspect = sizes.width / sizes.height
  camera.updateProjectionMatrix()

  renderer.setSize(sizes.width, sizes.height)
  applyPixelRatio()
  clouds.setSize(sizes.width, sizes.height)
  godRays.setSize()
})

// Animate
const timer = new THREE.Timer()

// Adaptive quality levels, best first: the render resolution scale, and the highest cloud
// preset allowed (the panel's choice is used when it is lower)
const qualityLevels = [
  { scale: 1, clouds: 'ultra' },
  { scale: 1, clouds: 'medium' },
  { scale: 0.85, clouds: 'low' },
  { scale: 0.7, clouds: 'low' },
]
let qualityLevel = 0
const cloudPresetNames = Object.keys(cloudQualityPresets)
const applyQualityLevel = () => {
  const level = qualityLevels[performanceSettings.adaptive ? qualityLevel : 0]
  const cap = cloudPresetNames.indexOf(level.clouds)
  const clouds_ = cloudPresetNames[Math.min(cloudPresetNames.indexOf(cloudSettings.quality), cap)]
  if (clouds_ !== appliedCloudQuality) {
    appliedCloudQuality = clouds_
    clouds.setQuality(clouds_)
  }
  if (level.scale !== renderScale.value) {
    renderScale.value = level.scale
    applyPixelRatio()
    godRays.setSize()
  }
}
let appliedCloudQuality = cloudSettings.quality
const setQualityLevel = (level) => {
  qualityLevel = THREE.MathUtils.clamp(level, 0, qualityLevels.length - 1)
  applyQualityLevel()
}

// FPS readout, top left (styled in style.css)
const fpsMeter = document.createElement('div')
fpsMeter.className = 'fps-meter'
fpsMeter.hidden = !performanceSettings.showFps
document.body.appendChild(fpsMeter)

// Frame timing: averaged over half a second for the readout. Adaptive quality looks at a
// few seconds: below 45 fps it steps down, above 57 it steps back up, and after each
// change it waits a moment before judging again
const frameStats = { frames: 0, time: 0, low: 0, high: 0, wait: 2 }
const updatePerformance = (realDelta) => {
  frameStats.frames++
  frameStats.time += realDelta
  if (frameStats.time < 0.5) return
  const fps = frameStats.frames / frameStats.time
  frameStats.frames = 0
  frameStats.time = 0
  if (performanceSettings.showFps) {
    const level = qualityLevels[performanceSettings.adaptive ? qualityLevel : 0]
    fpsMeter.innerHTML = `<strong>${Math.round(fps)}</strong> FPS<span>${(1000 / fps).toFixed(1)} ms · ${Math.round(level.scale * 100)}% · ${appliedCloudQuality}</span>`
  }
  if (!performanceSettings.adaptive) return
  frameStats.wait -= 0.5
  if (frameStats.wait > 0) return
  frameStats.low = fps < 45 ? frameStats.low + 1 : 0
  frameStats.high = fps > 57 ? frameStats.high + 1 : 0
  if (frameStats.low >= 4 && qualityLevel < qualityLevels.length - 1) {
    setQualityLevel(qualityLevel + 1)
    frameStats.low = 0
    frameStats.wait = 2
  } else if (frameStats.high >= 8 && qualityLevel > 0) {
    setQualityLevel(qualityLevel - 1)
    frameStats.high = 0
    frameStats.wait = 2
  }
}

const tick = (timestamp) => {
  timer.update(timestamp)
  // Capped so returning to a background tab doesn't jump every transition to its end
  const delta = Math.min(timer.getDelta(), 0.1)
  // Exponential damping: the fraction of the remaining distance to cover this frame
  const alpha = 1 - Math.exp(-transition.speed * delta)

  // Ease everything the panel drives toward its target
  updateWind(delta, alpha)
  updateSun(alpha)
  updateClouds(delta, alpha)
  easeUniforms(groundUniforms, groundTargets, alpha)
  easeUniforms(groundUniforms, maskTargets, alpha)
  easeUniforms(flowerUniforms, flowerTargets, alpha)
  blades.visible = groundUniforms.uShowMask.value < 0.995
  flowers.visible = blades.visible
  directionalLight.intensity += (sunState.level * sunState.cloudShade - directionalLight.intensity) * alpha
  ambientLight.intensity += (lightSettings.ambient - ambientLight.intensity) * alpha
  sunShadow.radius += (lightSettings.shadowSoftness - sunShadow.radius) * alpha
  sunShadow.intensity += (lightSettings.shadowStrength - sunShadow.intensity) * alpha

  // Ground map: keep building any new map in the background (a few ms per frame), then
  // crossfade it in, a little slower than the other transitions so the patches visibly
  // morph. Density and the crossfade wait while the blade list is being brought up to date
  advanceGroundMap(4)
  updateDensity(delta, alpha)
  if (!densityUpdate.dirty && mapFade.value < 1) {
    mapFade.value += (1 - mapFade.value) * (1 - Math.exp(-transition.speed * 0.5 * delta))
    if (mapFade.value > 0.995) mapFade.value = 1
  }

  // One shared clock drives the wind field for every blade
  windUniforms.uTime.value = timer.getElapsed()

  limitCameraHeight()
  controls.update()
  // March this frame's clouds from where the camera now is, then draw the scene with the
  // sky dome (which follows the camera so it never gets clipped) laying them over the sky,
  // through the god rays pass to the canvas
  clouds.render(camera, delta)
  sky.material.uniforms.uClouds.value = clouds.texture
  sky.position.copy(camera.position)
  godRays.render(scene, camera, clouds.texture)
  // Frame rate readout and adaptive quality, from the real (uncapped) frame time
  updatePerformance(timer.getDelta())

  window.requestAnimationFrame(tick)
}

window.requestAnimationFrame(tick)
