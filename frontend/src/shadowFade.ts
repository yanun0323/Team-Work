// Shadows that fade. A shadow map is either hit or not, so a see-through caster is drawn into it through
// a 4×4 ordered dither: at strength k it covers about k of the texels, which reads as a lighter shadow.

import * as THREE from 'three'

/** A depth material for `customDepthMaterial` whose `strength` (0–1) sets how much shadow is cast. */
export function fadingShadow() {
  const strength = { value: 1 }
  const m = new THREE.MeshDepthMaterial()
  m.onBeforeCompile = (s) => {
    s.uniforms.uShadowStrength = strength
    s.fragmentShader = s.fragmentShader
      .replace('void main() {', `uniform float uShadowStrength;
float bayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int b[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(b[i.y * 4 + i.x]) + 0.5) / 16.0;
}
void main() {
  if (bayer4(gl_FragCoord.xy) >= uShadowStrength) discard;`)
  }
  return {
    material: m,
    set: (k: number) => void (strength.value = k),
  }
}
