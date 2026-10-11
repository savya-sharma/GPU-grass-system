import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// Weathered granite boulders.
//
// - Shape: a subdivided sphere squashed to each stone's proportions, swelled into broad
//   rounded lobes by low-frequency noise, then cut by a few fracture planes. Each cut
//   flattens everything beyond it onto the plane through a smooth minimum, so the faces
//   are broad and flat, with crisp edges where the blend is tight and worn, rounded ones
//   where it is wide. The underside is cut flat where the stone sits in the ground
// - Crevices: each vertex records how concave the surface is around it (how far it sits
//   below the average of its neighbors), which the material darkens
// - Material: procedural granite in the shader, sampled in world space (the stones never
//   move), so the grain is the same size on every stone and never stretches. Warm and
//   neutral greys with taupe patches, fine dark and light mineral grains, darker
//   crevices, paler weathered tops, a slightly darker, earthier band near the ground, and
//   fine bump relief. Rough and matte, with the quartz grains a touch less rough
// - Every stone is built from its own seed, so the shapes are the same on every load

// Seeded random numbers (mulberry32)
export const createRandom = (seed) => {
  let state = seed * 7919 + 17
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Smooth 3D value noise for shaping, from a seeded lattice
const createNoise = (random) => {
  const size = 256
  const values = new Float32Array(size).map(() => random())
  const permutation = new Uint8Array(size * 2)
  const order = [...Array(size).keys()].sort(() => random() - 0.5)
  for (let i = 0; i < size * 2; i++) permutation[i] = order[i % size]
  const lattice = (x, y, z) => values[permutation[permutation[permutation[x & 255] + (y & 255)] + (z & 255)]]
  const fade = (t) => t * t * (3 - 2 * t)
  const noise = (x, y, z) => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const zi = Math.floor(z)
    const u = fade(x - xi)
    const v = fade(y - yi)
    const w = fade(z - zi)
    const lerp = THREE.MathUtils.lerp
    return lerp(
      lerp(lerp(lattice(xi, yi, zi), lattice(xi + 1, yi, zi), u), lerp(lattice(xi, yi + 1, zi), lattice(xi + 1, yi + 1, zi), u), v),
      lerp(lerp(lattice(xi, yi, zi + 1), lattice(xi + 1, yi, zi + 1), u), lerp(lattice(xi, yi + 1, zi + 1), lattice(xi + 1, yi + 1, zi + 1), u), v),
      w
    ) * 2 - 1
  }
  return (x, y, z) => noise(x, y, z) * 0.65 + noise(x * 2.1 + 5.2, y * 2.1, z * 2.1 - 3.7) * 0.35
}

// Smooth minimum: like min(a, b), but rounded over a band of width k
const smoothMin = (a, b, k) => {
  const h = THREE.MathUtils.clamp(0.5 + (0.5 * (b - a)) / k, 0, 1)
  return THREE.MathUtils.lerp(b, a, h) - k * h * (1 - h)
}

// One boulder, about the size of the old stones: roughly 1.6 wide, 1.3 deep and 0.8 tall
// at scale 1, with its base cut flat at y = -0.3 (the part that sits in the ground)
export const createBoulderGeometry = (random) => {
  const noise = createNoise(random)
  const geometry = mergeVertices(new THREE.IcosahedronGeometry(1, 12).deleteAttribute('normal').deleteAttribute('uv'))
  const positions = geometry.attributes.position

  // Proportions: from broad and low to blocky
  const scale = new THREE.Vector3(0.72 + random() * 0.16, 0.42 + random() * 0.14, 0.56 + random() * 0.14)
  const lumpiness = 0.08 + random() * 0.06
  const noiseOffset = new THREE.Vector3(random() * 50, random() * 50, random() * 50)

  // Fracture planes: mostly on the sides and top, a few close in for broad faces and some
  // further out that only shave a corner. Tight blends give the sharper fracture lines
  const planes = []
  const planeCount = 6 + Math.floor(random() * 3)
  for (let i = 0; i < planeCount; i++) {
    const angle = random() * Math.PI * 2
    const tilt = (random() - 0.25) * 1.3
    const normal = new THREE.Vector3(Math.cos(angle) * Math.cos(tilt), Math.sin(tilt), Math.sin(angle) * Math.cos(tilt)).normalize()
    planes.push({
      normal,
      offset: 0.34 + random() * 0.32,
      blend: random() < 0.6 ? 0.006 + random() * 0.012 : 0.03 + random() * 0.04,
    })
  }
  // Seen from outside, the far side of each plane is cut away, so scale offsets to the
  // stone's size along the plane normal
  const point = new THREE.Vector3()
  for (let i = 0; i < positions.count; i++) {
    point.fromBufferAttribute(positions, i)
    // Broad lobes and swellings
    const n = noise(point.x * 1.3 + noiseOffset.x, point.y * 1.3 + noiseOffset.y, point.z * 1.3 + noiseOffset.z)
    // plus smaller ripples, so the edges left by the cuts are uneven rather than ruled
    const ripple = noise(point.x * 3.6 - noiseOffset.y, point.y * 3.6 + noiseOffset.z, point.z * 3.6 + noiseOffset.x)
    point.multiplyScalar(1 + n * lumpiness + ripple * 0.035).multiply(scale)
    for (const plane of planes) {
      const reach = Math.abs(plane.normal.x) * scale.x + Math.abs(plane.normal.y) * scale.y + Math.abs(plane.normal.z) * scale.z
      const distance = point.dot(plane.normal)
      const limit = plane.offset * reach
      const cut = smoothMin(distance, limit, plane.blend)
      point.addScaledVector(plane.normal, cut - distance)
    }
    // Flat underside, where it sits in the soil
    point.y = -smoothMin(-point.y, 0.3, 0.06)
    positions.setXYZ(i, point.x, point.y, point.z)
  }
  geometry.computeVertexNormals()

  // Concavity per vertex: how far it sits below its neighbors' average, along its normal
  const index = geometry.index
  const neighborSum = new Float32Array(positions.count * 3)
  const neighborCount = new Float32Array(positions.count)
  for (let i = 0; i < index.count; i += 3) {
    const corners = [index.getX(i), index.getX(i + 1), index.getX(i + 2)]
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        if (a === b) continue
        neighborSum[corners[a] * 3] += positions.getX(corners[b])
        neighborSum[corners[a] * 3 + 1] += positions.getY(corners[b])
        neighborSum[corners[a] * 3 + 2] += positions.getZ(corners[b])
        neighborCount[corners[a]]++
      }
    }
  }
  const normals = geometry.attributes.normal
  const cavity = new Float32Array(positions.count)
  for (let i = 0; i < positions.count; i++) {
    const count = neighborCount[i]
    const dx = neighborSum[i * 3] / count - positions.getX(i)
    const dy = neighborSum[i * 3 + 1] / count - positions.getY(i)
    const dz = neighborSum[i * 3 + 2] / count - positions.getZ(i)
    const concave = dx * normals.getX(i) + dy * normals.getY(i) + dz * normals.getZ(i)
    cavity[i] = THREE.MathUtils.clamp(concave * 250, 0, 1)
  }
  geometry.setAttribute('aCavity', new THREE.BufferAttribute(cavity, 1))
  return geometry
}

// Shared granite material for every boulder
export const graniteMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 })
const graniteUniforms = {
  uGraniteBase: { value: new THREE.Color('#aaa7a2') },
  uGraniteWarm: { value: new THREE.Color('#b2aca4') },
  uGraniteTaupe: { value: new THREE.Color('#a39b91') },
  uGraniteDark: { value: new THREE.Color('#47464a') },
  uGraniteLight: { value: new THREE.Color('#e0ddd6') },
  uGraniteSoil: { value: new THREE.Color('#5e5446') },
}
graniteMaterial.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, graniteUniforms)
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
      attribute float aCavity;
      varying float vCavity;
      varying vec3 vGraniteWorld;
      varying float vGraniteHeight;`
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vCavity = aCavity;
      vGraniteWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
      // Height above the flat underside, in the stone's own units (0 at the soil line)
      vGraniteHeight = transformed.y + 0.3;`
    )

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      varying float vCavity;
      varying vec3 vGraniteWorld;
      varying float vGraniteHeight;
      uniform vec3 uGraniteBase;
      uniform vec3 uGraniteWarm;
      uniform vec3 uGraniteTaupe;
      uniform vec3 uGraniteDark;
      uniform vec3 uGraniteLight;
      uniform vec3 uGraniteSoil;

      float graniteHash(vec3 p) {
        p = fract(p * vec3(0.1031, 0.1030, 0.0973));
        p += dot(p, p.yxz + 33.33);
        return fract((p.x + p.y) * p.z);
      }

      float graniteNoise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        vec3 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(graniteHash(i), graniteHash(i + vec3(1, 0, 0)), u.x), mix(graniteHash(i + vec3(0, 1, 0)), graniteHash(i + vec3(1, 1, 0)), u.x), u.y),
          mix(mix(graniteHash(i + vec3(0, 0, 1)), graniteHash(i + vec3(1, 0, 1)), u.x), mix(graniteHash(i + vec3(0, 1, 1)), graniteHash(i + vec3(1, 1, 1)), u.x), u.y),
          u.z
        );
      }

      // Mineral grains: each cell of a 3D grid holds one grain at a random spot, of random
      // size and kind. Returns how much of a dark grain (x) and a light grain (y) covers p
      vec2 graniteGrains(vec3 p) {
        vec3 cell = floor(p);
        vec3 local = fract(p);
        vec2 grains = vec2(0.0);
        for (int z = -1; z <= 1; z++)
        for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++) {
          vec3 c = cell + vec3(float(x), float(y), float(z));
          float kind = graniteHash(c);
          vec3 center = vec3(float(x), float(y), float(z)) + vec3(graniteHash(c + 3.1), graniteHash(c + 7.7), graniteHash(c + 13.3));
          float size = 0.22 + 0.3 * graniteHash(c + 21.9);
          float cover = 1.0 - smoothstep(size * 0.6, size, length(center - local));
          if (kind > 0.78) grains.x = max(grains.x, cover);
          else if (kind < 0.16) grains.y = max(grains.y, cover);
        }
        return grains;
      }

      // Bump mapping from a height worked out in the shader, as three.js does for bump maps
      vec3 granitePerturbNormal(vec3 surfacePosition, vec3 surfaceNormal, vec2 heightSlope, float faceSign) {
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
      vec3 p = vGraniteWorld;
      // Broad color drift across each stone: neutral, warm and taupe greys
      float drift = graniteNoise(p * 1.6);
      float drift2 = graniteNoise(p * 4.3 + 11.0);
      vec3 stone = mix(uGraniteBase, uGraniteWarm, smoothstep(0.3, 0.75, drift));
      stone = mix(stone, uGraniteTaupe, smoothstep(0.55, 0.85, drift2) * 0.6);

      // Mineral grains: dark specks (mica, hornblende) and pale ones (feldspar, quartz),
      // a few millimeters across at this scale. Faded toward the average where a grain is
      // smaller than a pixel, so distant stones read as an even speckled grey, not noise
      vec2 grains = graniteGrains(p * 95.0);
      float grainDetail = 1.0 - smoothstep(0.35, 0.9, length(fwidth(p * 95.0)));
      float darkGrain = grains.x;
      float lightGrain = grains.y;
      stone = mix(stone, uGraniteDark, darkGrain * grainDetail * 0.7);
      stone = mix(stone, uGraniteLight, lightGrain * grainDetail * 0.6);
      // Faint speckle that survives at a distance
      stone *= 0.94 + 0.12 * graniteNoise(p * 22.0);

      // Weathering: paler on exposed, upward faces, in irregular patches
      vec3 worldNormal = normalize((vec4(normalize(vNormal), 0.0) * viewMatrix).xyz);
      float exposed = smoothstep(0.35, 0.9, worldNormal.y) * smoothstep(0.35, 0.7, graniteNoise(p * 3.1 + 4.0));
      stone = mix(stone, uGraniteLight * 0.92, exposed * 0.35);
      // Darker in crevices and fracture lines
      stone = mix(stone, uGraniteDark, smoothstep(0.1, 0.9, vCavity) * 0.4);
      // Earthier and darker where the stone meets the soil and grass
      stone = mix(uGraniteSoil, stone, smoothstep(0.02, 0.32, vGraniteHeight));
      diffuseColor.rgb = stone;`
    )
    .replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
      // Matte stone; the glassy quartz grains a little less rough
      roughnessFactor = mix(0.92, 0.72, lightGrain * grainDetail) + vCavity * 0.05;`
    )
    .replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
      // Fine relief: pitting and small undulations, faded out where it would be smaller
      // than a pixel so distant stones stay calm
      float relief = graniteNoise(p * 9.0) * 0.6 + graniteNoise(p * 26.0) * 0.3 + darkGrain * grainDetail * -0.15;
      float reliefDetail = 1.0 - smoothstep(0.4, 1.2, length(fwidth(p * 26.0)));
      vec2 reliefSlope = vec2(dFdx(relief), dFdy(relief)) * 0.012 * reliefDetail;
      normal = granitePerturbNormal(-vViewPosition, normal, reliefSlope, faceDirection);`
    )
}
