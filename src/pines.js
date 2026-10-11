import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// Japanese black pines (Pinus thunbergii): eight, at fixed spots, each built from its
// own seed so the stand is identical on every load.
//
// - Wood: every trunk, branch and twig is a tapering tube swept along a crooked curve, with
//   a lumpy cross-section. All of them are merged into one mesh with one bark material
// - Bark: procedural, in the shader. Each tube carries its own bark coordinates (around it
//   and along it, in plate-sized units), so the pattern wraps seamlessly and never
//   stretches. Irregular plates (cellular noise) split by deep fissures, broken into finer
//   scales, in charcoal, grey-brown and reddish-brown, with matching roughness and bump
// - Needles: foliage grows in separate, flattened pads at the branch ends, with open sky
//   between them. Each pad is covered in tufts of slender needles; one tuft geometry is
//   drawn thousands of times as a single instanced mesh, each copy turned, tilted, scaled
//   and tinted differently. Pads are lit as soft volumes: shaded deep green underneath,
//   restrained olive on the sunlit tips
// - Both materials are the standard lit material, so the trees follow the sun, its
//   shadows, the god rays and the clouds' shade. They never move, so they stay in the
//   frozen shadow map and cost nothing per frame beyond drawing them

// The trees, fixed. The first four: a dominant tree, two medium and one small, leaning
// one. The last four stand on the front-right part of the island, placed from a marked
// reference view (bigger marks taller trees). Position
// on the ground, height, crown width, lean (fraction of the height the top sits off its
// base) toward leanAzimuth (degrees, 0 = +x, 90 = +z), how strongly the branches sweep
// that way (windswept), how far up the first branch grows (fraction of the height), and
// the branch count
export const pineLayout = [
  { x: 5.0, z: -6.0, height: 11, width: 10, lean: 0.07, leanAzimuth: 200, windswept: 0.35, firstBranch: 0.3, branches: 12, seed: 11 },
  { x: 8.6, z: -2.4, height: 8, width: 7.4, lean: 0.09, leanAzimuth: 20, windswept: 0.3, firstBranch: 0.3, branches: 10, seed: 23 },
  { x: 2.3, z: -7.8, height: 7.6, width: 7, lean: 0.11, leanAzimuth: 150, windswept: 0.45, firstBranch: 0.32, branches: 9, seed: 37 },
  { x: 8.9, z: 2.4, height: 5, width: 5.2, lean: 0.24, leanAzimuth: -35, windswept: 0.55, firstBranch: 0.28, branches: 7, seed: 53 },
  { x: 4.55, z: 0.79, height: 9.4, width: 8.4, lean: 0.08, leanAzimuth: 120, windswept: 0.35, firstBranch: 0.3, branches: 11, seed: 67 },
  { x: 6.22, z: 5.54, height: 6.4, width: 6, lean: 0.12, leanAzimuth: 60, windswept: 0.4, firstBranch: 0.3, branches: 8, seed: 79 },
  { x: 3.31, z: 7.42, height: 4.2, width: 4.2, lean: 0.16, leanAzimuth: 160, windswept: 0.5, firstBranch: 0.26, branches: 6, seed: 89 },
  { x: 8.08, z: 7.42, height: 7.2, width: 6.4, lean: 0.14, leanAzimuth: 15, windswept: 0.45, firstBranch: 0.3, branches: 9, seed: 97 },
]

// Seeded random numbers (mulberry32)
const createRandom = (seed) => {
  let state = seed * 7919 + 13
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const up = new THREE.Vector3(0, 1, 0)

// A tube swept along a curve. radiusAt(t) gives the radius along it (t = 0..1). Each vertex
// gets bark coordinates: around the tube in plates (wrapping exactly at a whole number of
// plates, so there is no seam), along it in the same plate units (plates are taller than
// wide), the plate count, and the local radius (which scales the bark's relief)
const buildTube = (curve, radiusAt, { radial, segmentLength, plateWidth, lumpiness, phase, rootFlare = 0 }) => {
  const length = curve.getLength()
  const segments = Math.max(2, Math.ceil(length / segmentLength))
  const frames = curve.computeFrenetFrames(segments, false)
  const baseRadius = radiusAt(0)
  const plates = THREE.MathUtils.clamp(Math.round((Math.PI * 2 * baseRadius) / plateWidth), 3, 30)
  const plateLength = ((Math.PI * 2 * baseRadius) / plates) * 2.4

  const positions = []
  const normals = []
  const bark = []
  const indices = []
  const point = new THREE.Vector3()
  const direction = new THREE.Vector3()

  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    curve.getPointAt(t, point)
    const normal = frames.normals[i]
    const binormal = frames.binormals[i]
    const along = t * length
    const radius = radiusAt(t)
    for (let j = 0; j <= radial; j++) {
      const angle = (j / radial) * Math.PI * 2
      // Lumpy, irregular cross-section that shifts along the tube
      let shape = 1 + lumpiness * (0.6 * Math.sin(3 * angle + phase + along * 1.3) + 0.4 * Math.sin(5 * angle - phase * 2 + along * 2.7))
      // Root buttresses: a few lobes splaying out at the very base
      shape += rootFlare * Math.max(0, Math.sin(5 * angle + phase)) * (1 - THREE.MathUtils.smoothstep(t, 0, 0.06))
      direction.copy(normal).multiplyScalar(Math.cos(angle)).addScaledVector(binormal, Math.sin(angle))
      positions.push(point.x + direction.x * radius * shape, point.y + direction.y * radius * shape, point.z + direction.z * radius * shape)
      normals.push(direction.x, direction.y, direction.z)
      bark.push((j / radial) * plates, along / plateLength, plates, radius)
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j
      const b = a + radial + 1
      indices.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('aBark', new THREE.Float32BufferAttribute(bark, 4))
  geometry.setIndex(indices)
  return geometry
}

// Turns a horizontal direction by an angle around the vertical
const turnAround = (vector, angle) => vector.applyAxisAngle(up, angle)

// One pine around its own base at the origin: its wood (tube geometries) and its foliage
// pads (center, radius, thickness)
const buildPine = (spec) => {
  const random = createRandom(spec.seed)
  const jitter = (amount) => (random() - 0.5) * 2 * amount
  const tubes = []
  const pads = []
  const H = spec.height
  const leanAngle = THREE.MathUtils.degToRad(spec.leanAzimuth)
  const leanDirection = new THREE.Vector3(Math.cos(leanAngle), 0, Math.sin(leanAngle))
  const side = new THREE.Vector3(-leanDirection.z, 0, leanDirection.x)

  // Trunk: leans as it rises and wanders in a gentle S, so no two are alike. Starts just
  // below the ground (deep enough to stay rooted on a slope, not so deep it shows under
  // the island's thin edge from a low camera)
  const wobble = 0.03 + random() * 0.04
  const wobblePhase = random() * Math.PI * 2
  const trunkPoints = []
  for (let k = 0; k <= 7; k++) {
    const t = k / 7
    const offset = leanDirection.clone().multiplyScalar(spec.lean * H * Math.pow(t, 1.35) + Math.sin(t * Math.PI * 1.6 + wobblePhase) * wobble * H * t)
    offset.addScaledVector(side, Math.sin(t * Math.PI * 1.2 + wobblePhase * 1.7) * wobble * 0.6 * H * t + jitter(0.012 * H) * t)
    trunkPoints.push(new THREE.Vector3(offset.x, k === 0 ? -0.15 : t * H, offset.z))
  }
  const trunk = new THREE.CatmullRomCurve3(trunkPoints, false, 'centripetal')
  const trunkBase = H * (0.038 + random() * 0.006)
  const trunkRadius = (t) => trunkBase * (1 - 0.8 * Math.pow(t, 0.8)) * (1 + 0.45 * (1 - THREE.MathUtils.smoothstep(t, 0, 0.08)))
  tubes.push(buildTube(trunk, trunkRadius, { radial: 18, segmentLength: 0.16, plateWidth: 0.17, lumpiness: 0.08, phase: random() * 6, rootFlare: 0.35 }))

  // A branch: a crooked curve through a few points, tapering from its base radius
  const addBranch = (points, baseRadius, tipRadius, radial) => {
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal')
    const radiusAt = (t) => THREE.MathUtils.lerp(baseRadius, tipRadius, Math.pow(t, 0.8))
    tubes.push(buildTube(curve, radiusAt, { radial, segmentLength: 0.14, plateWidth: 0.11, lumpiness: 0.05, phase: random() * 6 }))
    return curve
  }

  const addPad = (center, radius, thickness) => pads.push({ center: center.clone(), radius, thickness })

  // Fine twigs fanning up and out from a point into its pad, so the needles have wood
  // under them
  const addTwigs = (origin, direction, length, radius, count) => {
    for (let i = 0; i < count; i++) {
      const twigDirection = turnAround(direction.clone(), jitter(0.9)).setY(0).normalize()
      const end = origin.clone().addScaledVector(twigDirection, length * (0.6 + random() * 0.5)).addScaledVector(up, length * (0.25 + random() * 0.35))
      const middle = origin.clone().lerp(end, 0.5).addScaledVector(up, jitter(length * 0.12))
      addBranch([origin.clone(), middle, end], radius, radius * 0.4, 4)
    }
  }

  // Primary branches up the trunk: low ones long, high ones short, turned around the
  // trunk irregularly and swept toward the lean. Each heads out and slightly up, droops
  // through its middle and turns up again at the tip, with a few kinks along the way
  const span = 0.93 - spec.firstBranch
  for (let b = 0; b < spec.branches; b++) {
    const t = spec.firstBranch + span * ((b + 0.2 + random() * 0.6) / spec.branches)
    const base = trunk.getPointAt(t)
    const azimuth = b * 2.39996 + jitter(0.7)
    const outward = new THREE.Vector3(Math.cos(azimuth), 0, Math.sin(azimuth)).addScaledVector(leanDirection, spec.windswept).normalize()
    const height01 = (t - spec.firstBranch) / span
    const length = spec.width * 0.5 * (1 - 0.6 * height01) * (1 + 0.4 * outward.dot(leanDirection)) * (0.7 + random() * 0.5)
    const rise = 0.2 + random() * 0.35
    const across = new THREE.Vector3(-outward.z, 0, outward.x)
    const points = [
      base.clone(),
      base.clone().addScaledVector(outward, length * 0.3).addScaledVector(up, length * rise * 0.45).addScaledVector(across, jitter(length * 0.1)),
      base.clone().addScaledVector(outward, length * 0.62).addScaledVector(up, length * rise * 0.35).addScaledVector(across, jitter(length * 0.14)),
      base.clone().addScaledVector(outward, length).addScaledVector(up, length * (rise * 0.3 + 0.06)).addScaledVector(across, jitter(length * 0.1)),
    ]
    const baseRadius = trunkRadius(t) * (0.42 + random() * 0.15)
    const branch = addBranch(points, baseRadius, baseRadius * 0.22, 9)

    // A pad at the tip, carried on a few twigs
    const tip = points[3]
    const padRadius = THREE.MathUtils.clamp(length * 0.4, 0.55, 1.45)
    addTwigs(tip, outward, padRadius * 0.6, baseRadius * 0.2, 3)
    addPad(tip.clone().addScaledVector(up, padRadius * 0.22), padRadius, padRadius * (0.48 + random() * 0.14))
    if (length > 2.2) {
      const along = branch.getPointAt(0.55 + random() * 0.15)
      const innerPad = padRadius * (0.6 + random() * 0.15)
      addPad(along.addScaledVector(up, innerPad * 0.35), innerPad, innerPad * 0.5)
    }

    // Secondary branches off to either side, each with its own smaller pad
    const secondaryCount = length > 1.6 ? 2 + Math.floor(random() * 2) : 1
    for (let k = 0; k < secondaryCount; k++) {
      const s = 0.35 + random() * 0.45
      const origin = branch.getPointAt(s)
      const sideways = turnAround(outward.clone(), (k % 2 === 0 ? 1 : -1) * (0.6 + random() * 0.6)).normalize()
      const secondaryLength = length * (0.3 + random() * 0.22)
      const end = origin.clone().addScaledVector(sideways, secondaryLength).addScaledVector(up, secondaryLength * (0.15 + random() * 0.25))
      const middle = origin.clone().lerp(end, 0.5).addScaledVector(up, secondaryLength * jitter(0.12))
      const secondaryRadius = baseRadius * (1 - 0.75 * s) * 0.6
      addBranch([origin, middle, end], secondaryRadius, secondaryRadius * 0.35, 6)
      const secondaryPad = THREE.MathUtils.clamp(secondaryLength * 0.75, 0.4, 1.05)
      addTwigs(end, sideways, secondaryPad * 0.55, secondaryRadius * 0.3, 2)
      addPad(end.clone().addScaledVector(up, secondaryPad * 0.2), secondaryPad, secondaryPad * (0.46 + random() * 0.14))
    }
  }

  // The crown: a broad, rounded pad over the top of the trunk, with a few short leaders
  const top = trunk.getPointAt(1)
  const crownPad = spec.width * 0.13 + 0.45
  addTwigs(top, leanDirection, crownPad * 0.6, trunkRadius(1) * 0.6, 4)
  addPad(top.clone().addScaledVector(up, crownPad * 0.2), crownPad, crownPad * 0.5)

  return { wood: mergeGeometries(tubes), pads, tubes }
}

// One tuft: slender needles fanning up and out from a point, of uneven length and angle.
// Each needle is a single thin triangle (two sides, so it is seen from both). Vertex
// colors run from shaded at the base to a lighter, slightly olive tip
const createTuftGeometry = (random) => {
  const positions = []
  const colors = []
  const direction = new THREE.Vector3()
  const across = new THREE.Vector3()
  const helper = new THREE.Vector3()
  const needles = 28
  for (let i = 0; i < needles; i++) {
    // Spread within a cone around +y, wider at the outside of the tuft
    const spread = Math.pow(random(), 0.8) * 0.85
    const turn = random() * Math.PI * 2
    direction.set(Math.sin(spread) * Math.cos(turn), Math.cos(spread), Math.sin(spread) * Math.sin(turn))
    const length = 0.12 + random() * 0.11
    const halfWidth = 0.004 + random() * 0.003
    helper.set(random() - 0.5, random() - 0.5, random() - 0.5)
    across.crossVectors(direction, helper).normalize().multiplyScalar(halfWidth)
    const root = direction.clone().multiplyScalar(0.01)
    const tip = direction.clone().multiplyScalar(length)
    positions.push(root.x - across.x, root.y - across.y, root.z - across.z, root.x + across.x, root.y + across.y, root.z + across.z, tip.x, tip.y, tip.z)
    colors.push(0.5, 0.55, 0.5, 0.5, 0.55, 0.5, 1.12, 1.08, 0.78)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.computeVertexNormals()
  return geometry
}

// Bark, procedural: cellular noise that repeats exactly around each tube
const barkMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85 })
const barkUniforms = {
  uBarkPlate: { value: new THREE.Color('#6e6158') },
  uBarkPlateAlt: { value: new THREE.Color('#4c433d') },
  uBarkRed: { value: new THREE.Color('#74493a') },
  uBarkCrevice: { value: new THREE.Color('#150f0c') },
}
barkMaterial.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, barkUniforms)
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 aBark;\nvarying vec4 vBark;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBark = aBark;')

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      varying vec4 vBark;
      uniform vec3 uBarkPlate;
      uniform vec3 uBarkPlateAlt;
      uniform vec3 uBarkRed;
      uniform vec3 uBarkCrevice;

      vec2 barkHash(vec2 p) {
        p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
        return fract(sin(p) * 43758.5453);
      }

      // Cellular noise whose x axis repeats every period cells: nearest and second
      // nearest distance, and a random value for the nearest cell
      vec3 barkCells(vec2 p, float period) {
        vec2 cell = floor(p);
        vec2 local = fract(p);
        float nearest = 8.0;
        float second = 8.0;
        float id = 0.0;
        for (int y = -1; y <= 1; y++) {
          for (int x = -1; x <= 1; x++) {
            vec2 offset = vec2(float(x), float(y));
            vec2 c = cell + offset;
            vec2 h = barkHash(vec2(mod(c.x, period), c.y));
            float d = length(offset + 0.15 + 0.7 * h - local);
            if (d < nearest) {
              second = nearest;
              nearest = d;
              id = h.x;
            } else if (d < second) {
              second = d;
            }
          }
        }
        return vec3(nearest, second, id);
      }

      // Bump mapping from a height worked out in the shader (as three.js does for bump
      // maps), with the height in world units
      vec3 barkPerturbNormal(vec3 surfacePosition, vec3 surfaceNormal, vec2 heightSlope, float faceSign) {
        vec3 sigmaX = normalize(dFdx(surfacePosition));
        vec3 sigmaY = normalize(dFdy(surfacePosition));
        vec3 r1 = cross(sigmaY, surfaceNormal);
        vec3 r2 = cross(surfaceNormal, sigmaX);
        float determinant = dot(sigmaX, r1) * faceSign;
        vec3 gradient = sign(determinant) * (heightSlope.x * r1 + heightSlope.y * r2);
        return normalize(abs(determinant) * surfaceNormal - gradient);
      }`
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      // Fissures meander: shift across the tube with height (a shift that depends only on
      // the height, plus whole turns around it, keeps the pattern seamless)
      vec2 barkUv = vBark.xy;
      barkUv.x += sin(barkUv.y * 0.8) * 0.18 + sin(barkUv.y * 2.3 + 6.2832 * vBark.x / vBark.z) * 0.06;
      vec3 plates = barkCells(barkUv, vBark.z);
      float plateEdge = plates.y - plates.x;
      // Deep cracks between the plates, and finer scaly cracks across each plate
      float fissure = 1.0 - smoothstep(0.05, 0.3, plateEdge + 0.12 * (barkHash(floor(barkUv * vec2(1.0, 0.5))).x - 0.5));
      vec3 scales = barkCells(barkUv * vec2(2.0, 1.6) + 7.3, vBark.z * 2.0);
      float scaleCrack = (1.0 - smoothstep(0.0, 0.09, scales.y - scales.x)) * (1.0 - fissure);
      // Each plate is slightly domed and sits at its own height
      float plateTop = smoothstep(0.0, 0.45, plateEdge);
      float barkHeight = plateTop * (0.7 + 0.3 * plates.z) - scaleCrack * 0.3 - fissure * 0.7;

      vec3 plateColor = mix(uBarkPlate, uBarkPlateAlt, smoothstep(0.2, 0.85, plates.z));
      plateColor = mix(plateColor, uBarkRed, smoothstep(0.6, 0.95, scales.z) * 0.55);
      // Weathered, paler plate faces
      plateColor *= 0.85 + 0.3 * plateTop * (0.8 + 0.4 * scales.z);
      diffuseColor.rgb = mix(plateColor, uBarkCrevice, max(fissure, scaleCrack * 0.55));`
    )
    .replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
      // Matte everywhere, a touch less so on the worn plate faces
      roughnessFactor = mix(0.8, 1.0, max(fissure, scaleCrack));`
    )
    .replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
      // Relief about an eighth of the local radius deep; faded out where the plates get
      // smaller than a pixel, so distant trunks don't sparkle
      float barkDetail = 1.0 - smoothstep(0.25, 0.7, length(fwidth(vBark.xy)));
      vec2 barkSlope = vec2(dFdx(barkHeight), dFdy(barkHeight)) * vBark.w * 0.12 * barkDetail;
      normal = barkPerturbNormal(-vViewPosition, normal, barkSlope, faceDirection);`
    )
}

// Needles: lit as soft volumes per pad (each vertex's normal points out from its pad's
// middle, more up than sideways), so pads shade from sunlit tops to dark undersides
// instead of every needle flickering. Both sides use that normal
const needleMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.7 })
needleMaterial.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 aPadCenter;')
    .replace(
      '#include <defaultnormal_vertex>',
      `#include <defaultnormal_vertex>
      vec3 needleWorld = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
      vec3 padNormal = normalize((needleWorld - aPadCenter) * vec3(1.0, 1.9, 1.0) + vec3(0.0, 0.2, 0.0));
      transformedNormal = normalize(mix(normalMatrix * padNormal, transformedNormal, 0.2));`
    )
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);')
    // Thin needles let some sunlight through: a soft glow looking toward the sun, so a
    // canopy against the light stays green rather than turning black
    .replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      #if NUM_DIR_LIGHTS > 0
        float needleBacklight = pow(saturate(dot(directionalLights[0].direction, -geometryViewDir)), 3.0);
        reflectedLight.directDiffuse += directionalLights[0].color * diffuseColor.rgb * needleBacklight * 0.35;
      #endif`
    )
}

// Builds the stand at its fixed spots, rooted on the ground. Returns the wood mesh and the
// needle mesh (two draw calls for the whole stand)
export const createBlackPines = (getGroundHeight) => {
  const woodGeometries = []
  const tufts = []
  const matrix = new THREE.Matrix4()
  const turn = new THREE.Quaternion()
  const one = new THREE.Vector3(1, 1, 1)

  // Needle tones: deep forest green, the main dark green, and an olive green
  const greens = [new THREE.Color('#223f26'), new THREE.Color('#2f5130'), new THREE.Color('#3d5f35'), new THREE.Color('#56693a')]

  for (const spec of pineLayout) {
    const { wood, pads, tubes } = buildPine(spec)
    tubes.forEach((tube) => tube.dispose())
    const random = createRandom(spec.seed + 1000)
    // A slight sink keeps the root flare inside the ground on slopes
    const base = new THREE.Vector3(spec.x, getGroundHeight(spec.x, spec.z) - 0.08, spec.z)
    matrix.makeTranslation(base.x, base.y, base.z)
    woodGeometries.push(wood.applyMatrix4(matrix))

    for (const pad of pads) {
      const center = pad.center.clone().add(base)
      const count = Math.round(pad.radius * pad.radius * 150)
      // Ragged pads: the needles thin out in a few directions around each pad, so its
      // outline is broken and sky shows through, not a neat clipped disc
      const gapPhase = random() * Math.PI * 2
      const gapCount = 2 + Math.floor(random() * 3)
      for (let i = 0; i < count; i++) {
        // Spread over the pad: mostly its domed top and rim, a few underneath
        const angle = random() * Math.PI * 2
        const fullness = 0.5 + 0.5 * Math.sin(angle * gapCount + gapPhase)
        if (random() > 0.35 + 0.65 * fullness) continue
        const distance = pad.radius * Math.sqrt(random())
        const edge = distance / pad.radius
        const underneath = random() < 0.2
        const dome = Math.sqrt(Math.max(0, 1 - edge * edge)) * pad.thickness * (0.55 + random() * 0.45)
        const position = new THREE.Vector3(
          center.x + Math.cos(angle) * distance,
          center.y + (underneath ? -dome * 0.6 : dome),
          center.z + Math.sin(angle) * distance
        )
        // Tufts point up and outward, more outward toward the rim; underneath ones droop
        const axis = new THREE.Vector3(Math.cos(angle) * edge * 0.9, underneath ? -0.2 : 1, Math.sin(angle) * edge * 0.9)
        axis.x += (random() - 0.5) * 0.5
        axis.z += (random() - 0.5) * 0.5
        axis.normalize()
        turn.setFromUnitVectors(up, axis)
        turn.multiply(new THREE.Quaternion().setFromAxisAngle(up, random() * Math.PI * 2))
        const size = 1.0 + random() * 0.6
        // Shaded green under and inside the pad, lighter toward the top
        const height01 = THREE.MathUtils.clamp((position.y - center.y) / pad.thickness * 0.5 + 0.5, 0, 1)
        const tone = greens[Math.min(greens.length - 1, Math.floor(height01 * 2.2 + random() * 1.6))].clone()
        tone.multiplyScalar(0.88 + random() * 0.24)
        tufts.push({ position, rotation: turn.clone(), size, tone, center })
      }
    }
  }

  const wood = new THREE.Mesh(mergeGeometries(woodGeometries), barkMaterial)
  woodGeometries.forEach((geometry) => geometry.dispose())

  const tuftGeometry = createTuftGeometry(createRandom(97))
  const padCenters = new Float32Array(tufts.length * 3)
  tufts.forEach((tuft, i) => padCenters.set([tuft.center.x, tuft.center.y, tuft.center.z], i * 3))
  tuftGeometry.setAttribute('aPadCenter', new THREE.InstancedBufferAttribute(padCenters, 3))
  const needles = new THREE.InstancedMesh(tuftGeometry, needleMaterial, tufts.length)
  const scale = new THREE.Vector3()
  tufts.forEach((tuft, i) => {
    matrix.compose(tuft.position, tuft.rotation, scale.copy(one).multiplyScalar(tuft.size))
    needles.setMatrixAt(i, matrix)
    needles.setColorAt(i, tuft.tone)
  })
  needles.instanceMatrix.needsUpdate = true
  needles.computeBoundingSphere()

  return { wood, needles, treeCount: pineLayout.length, tuftCount: tufts.length }
}
