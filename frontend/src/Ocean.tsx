// The sea: colour follows the distance from the shore, with surf, foam rolling outwards and wind ripples
// (no foam or ripples with less detail).

import { useFrame, useThree } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { FIELD_RES } from './land'
import { SEA_D0, SEA_DSPAN, SEA_LEVEL, type SeaMap } from './Island'
import { usePrefs } from './prefs'
import { SEA_SIZE } from './camera'
import { MAX_FRAME } from './PixelPass'
import { light } from './daylight'


const head = /* glsl */ `
varying vec3 vSea;
uniform float uTime;
uniform float uDetail;
uniform sampler2D uDist;
uniform vec2 uOrigin;
uniform vec2 uN;
uniform vec3 uShallow;
uniform vec3 uMid;
uniform vec3 uDeep;

float shore(vec2 p) {
  vec2 uv = ((p - uOrigin) * ${FIELD_RES.toFixed(1)} + 0.5) / uN;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return ${(SEA_DSPAN - SEA_D0).toFixed(1)};
  return texture2D(uDist, uv).r * ${SEA_DSPAN.toFixed(1)} - ${SEA_D0.toFixed(1)};
}
float h21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
`

const body = /* glsl */ `
vec2 p = vSea.xz;
float t = uTime;
float d = shore(p);
float n1 = vnoise(p * 0.28 + vec2(t * 0.03, t * 0.02));
float n2 = vnoise(p * 0.9 - vec2(t * 0.05, -t * 0.04));
// colour bands loosely follow the coast
float band = d + (n1 - 0.5) * 1.3 + (n2 - 0.5) * 0.4;
vec3 sea = mix(uShallow, uMid, smoothstep(0.2, 3.0, band));
sea = mix(sea, uDeep, smoothstep(3.5, 12.0, band));
sea *= 0.96 + 0.08 * vnoise(p * 0.07 + t * 0.008);
// surf along the beach, breathing in and out
float wl = d - 0.08 * sin(t * 1.4 + p.x * 1.3 + p.y * 0.9);
float surf = step(wl, 0.12 + 0.12 * n2) * step(-0.4, wl);
// three foam lines leave the shore, spread, break up and fade
float foam = 0.0;
for (int k = 0; k < 3; k++) {
  if (uDetail < 0.5) break;
  float ph = fract(t * 0.11 + float(k) / 3.0);
  float r = 0.35 + ph * 2.6 + (vnoise(p * 0.6 + float(k) * 5.1) - 0.5) * (0.25 + ph * 0.5);
  float line = step(abs(d - r), 0.07 * (1.0 - ph) + 0.03);
  float broken = step(0.25 + 0.6 * ph, vnoise(p * 1.3 + vec2(float(k) * 11.7, -t * 0.12)));
  foam = max(foam, line * broken * (1.0 - ph));
}
// wind ripples on open water: short pale dashes drifting downwind
vec2 q = mat2(0.8, 0.6, -0.6, 0.8) * p; // q.x runs about along the screen horizontal
vec2 cell = floor(vec2(q.x * 1.1 - t * 0.25, q.y * 1.4));
float dash = uDetail * step(0.965, h21(cell)) * step(abs(fract(q.y * 1.4) - 0.5), 0.14) * smoothstep(3.0, 6.0, d);
sea = mix(sea, vec3(1.0), max(surf * 0.9, foam * 0.7));
sea = mix(sea, vec3(1.0), dash * 0.22);
vec4 diffuseColor = vec4(sea, opacity);
`

export function Ocean({ map, calm }: { map: SeaMap; calm: boolean }) {
  const mesh = useRef<THREE.Mesh>(null)
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3 } | null
  const detail = usePrefs((s) => s.detail)
  const material = useMemo(() => {
    const m = new THREE.MeshToonMaterial({ color: '#ffffff' })
    const uniforms = {
      uTime: { value: 0 },
      // less detail: no foam lines or wind ripples, only the surf along the beach
      uDetail: { value: 1 },
      uDist: { value: map.texture },
      uOrigin: { value: map.origin },
      uN: { value: map.n },
      // the time of day's colours, the very objects the sun updates
      uShallow: { value: light.shallow },
      uMid: { value: light.mid },
      uDeep: { value: light.deep },
    }
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSea;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvSea = (modelMatrix * vec4(transformed, 1.0)).xyz;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${head}`)
        .replace('vec4 diffuseColor = vec4( diffuse, opacity );', body)
    }
    m.customProgramCacheKey = () => 'fusion-sea'
    return { m, uniforms }
  }, [map])

  useFrame((_, dt) => {
    if (!calm) material.uniforms.uTime.value += Math.min(dt, MAX_FRAME)
    material.uniforms.uDetail.value = detail ? 1 : 0
    // the plane follows the view so the sea never ends; the pattern is in world space, so it doesn't slide
    const t = controls?.target
    if (t && mesh.current) mesh.current.position.set(Math.round(t.x), SEA_LEVEL, Math.round(t.z))
  })

  return (
    <mesh ref={mesh} rotation-x={-Math.PI / 2} position={[0, SEA_LEVEL, 0]} material={material.m} receiveShadow>
      <planeGeometry args={[SEA_SIZE, SEA_SIZE]} />
    </mesh>
  )
}
