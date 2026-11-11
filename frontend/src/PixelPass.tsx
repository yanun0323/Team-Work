// Pixel-art look: draw the scene small, blow it up with hard pixel edges, and ink the outlines.

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'

/**
 * Objects on this layer are drawn, and cast shadows, but are left out of the outline pass:
 * see-through building shells and the invisible cloud shadow casters.
 */
export const NO_OUTLINE_LAYER = 1

const vert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`

const frag = /* glsl */ `
#include <packing>
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform sampler2D uNormal;
uniform vec2 uTarget;   // low-res target size, texels
uniform vec2 uScreen;   // screen size, texels (may be fractional)
uniform vec2 uShift;    // camera snap remainder, texels
uniform float uNear;
uniform float uFar;
uniform float uDepthStep; // world units of depth that count as a silhouette
uniform vec3 uInk;
varying vec2 vUv;

vec2 base;
vec2 uvAt(vec2 o) { return (base + o + 0.5) / uTarget; }
float depthAt(vec2 o) { return orthographicDepthToViewZ(texture2D(uDepth, uvAt(o)).r, uNear, uFar); }
vec3 normalAt(vec2 o) { return texture2D(uNormal, uvAt(o)).rgb * 2.0 - 1.0; }

void main() {
  // the target has a one-texel border, so the shifted lookup never leaves it
  base = floor(vUv * uScreen + (uTarget - uScreen) * 0.5 + uShift);
  vec4 color = texture2D(uColor, uvAt(vec2(0.0)));
  float z = depthAt(vec2(0.0));
  vec3 n = normalAt(vec2(0.0));
  // silhouettes: this texel is in front of a neighbour by more than a step; only the near side is inked
  float silhouette = 0.0;
  float crease = 0.0;
  vec2 dirs[4];
  dirs[0] = vec2(1.0, 0.0); dirs[1] = vec2(-1.0, 0.0); dirs[2] = vec2(0.0, 1.0); dirs[3] = vec2(0.0, -1.0);
  for (int k = 0; k < 4; k++) {
    float dz = z - depthAt(dirs[k]);
    silhouette = max(silhouette, step(uDepthStep, dz));
    // creases: the surface turns sharply, drawn on the face nearer the camera
    vec3 m = normalAt(dirs[k]);
    float turn = 1.0 - dot(n, m);
    crease = max(crease, step(0.4, turn) * step(-0.01, dz) * step(0.0, dot(n - m, vec3(1.0))));
  }
  float ink = silhouette > 0.0 ? 0.45 : crease * 0.18;
  color.rgb = mix(color.rgb, color.rgb * uInk, ink);
  gl_FragColor = vec4(color.rgb, 1.0);
  #include <colorspace_fragment>
}`

const BACKGROUND_FPS = 5
/**
 * The longest step, in seconds, any motion takes in one frame: well over a frame at BACKGROUND_FPS, so things keep
 * their speed while another app has focus even if frames come late, but coming back after a long time away doesn't
 * make them jump.
 */
export const MAX_FRAME = 1.1

/**
 * Takes over R3F rendering. The camera is snapped to whole texels for the low-res render and the remainder is
 * applied when scaling up, so panning stays smooth and the pixels don't crawl.
 */
export function PixelPass({ pixel = 2 }: { pixel?: number }) {
  const { gl, scene, camera, size, invalidate } = useThree()

  // The canvas runs on demand: with focus, ask for a frame on every display refresh, so the ambient motion
  // follows the screen's own rate. Without focus, wake only when one of the BACKGROUND_FPS frames is due,
  // rather than polling at the display's refresh rate. R3F schedules the actual drawing on requestAnimationFrame.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let frame: number | undefined
    const tick = () => {
      if (document.hidden) return
      invalidate()
      if (document.hasFocus()) frame = requestAnimationFrame(tick)
      else timer = setTimeout(tick, 1000 / BACKGROUND_FPS)
    }
    const restart = () => {
      clearTimeout(timer)
      if (frame !== undefined) cancelAnimationFrame(frame)
      tick()
    }
    window.addEventListener('focus', restart)
    window.addEventListener('blur', restart)
    document.addEventListener('visibilitychange', restart)
    restart()
    return () => {
      clearTimeout(timer)
      if (frame !== undefined) cancelAnimationFrame(frame)
      window.removeEventListener('focus', restart)
      window.removeEventListener('blur', restart)
      document.removeEventListener('visibilitychange', restart)
    }
  }, [invalidate])

  const res = useMemo(() => {
    const opts = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, type: THREE.HalfFloatType }
    const color = new THREE.WebGLRenderTarget(1, 1, { ...opts, depthTexture: new THREE.DepthTexture(1, 1) })
    const normal = new THREE.WebGLRenderTarget(1, 1, opts)
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: color.texture },
        uDepth: { value: color.depthTexture },
        uNormal: { value: normal.texture },
        uTarget: { value: new THREE.Vector2() },
        uScreen: { value: new THREE.Vector2() },
        uShift: { value: new THREE.Vector2() },
        uNear: { value: 1 },
        uFar: { value: 600 },
        uDepthStep: { value: 0.3 },
        uInk: { value: new THREE.Color(0.32, 0.28, 0.42) },
      },
      vertexShader: vert,
      fragmentShader: frag,
      depthTest: false,
      depthWrite: false,
    })
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
    quad.frustumCulled = false
    const quadScene = new THREE.Scene()
    quadScene.add(quad)
    return { color, normal, material, quad, quadScene, quadCamera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), normals: new THREE.MeshNormalMaterial() }
  }, [])

  useEffect(() => () => {
    res.color.dispose()
    res.normal.dispose()
    res.material.dispose()
    res.normals.dispose()
    res.quad.geometry.dispose()
  }, [res])

  const target = useMemo(() => {
    const w = Math.ceil(size.width / pixel) + 2
    const h = Math.ceil(size.height / pixel) + 2
    res.color.setSize(w, h)
    res.normal.setSize(w, h)
    res.material.uniforms.uTarget.value.set(w, h)
    res.material.uniforms.uScreen.value.set(size.width / pixel, size.height / pixel)
    return { w, h }
  }, [size.width, size.height, pixel, res])

  useEffect(() => {
    camera.layers.enable(NO_OUTLINE_LAYER)
    gl.shadowMap.autoUpdate = false
    return () => void (gl.shadowMap.autoUpdate = true)
  }, [gl, camera])

  const right = useMemo(() => new THREE.Vector3(), [])
  const up = useMemo(() => new THREE.Vector3(), [])
  const kept = useMemo(() => new THREE.Vector3(), [])

  useFrame(() => {
    const cam = camera as THREE.OrthographicCamera
    const u = res.material.uniforms
    cam.updateMatrixWorld()
    const texel = pixel / cam.zoom
    right.setFromMatrixColumn(cam.matrixWorld, 0)
    up.setFromMatrixColumn(cam.matrixWorld, 1)
    const px = cam.position.dot(right) / texel
    const py = cam.position.dot(up) / texel
    const fx = px - Math.round(px)
    const fy = py - Math.round(py)
    kept.copy(cam.position)
    cam.position.addScaledVector(right, -fx * texel).addScaledVector(up, -fy * texel)
    const frame = [cam.left, cam.right, cam.top, cam.bottom] as const
    // R3F's orthographic frustum is in CSS pixels before zoom; cover the target exactly
    cam.left = (-target.w * pixel) / 2
    cam.right = (target.w * pixel) / 2
    cam.top = (target.h * pixel) / 2
    cam.bottom = (-target.h * pixel) / 2
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()

    gl.shadowMap.needsUpdate = true
    gl.setRenderTarget(res.color)
    gl.clear()
    gl.render(scene, cam)
    const override = scene.overrideMaterial
    const bg = scene.background
    scene.overrideMaterial = res.normals
    scene.background = null
    cam.layers.disable(NO_OUTLINE_LAYER)
    gl.setRenderTarget(res.normal)
    gl.clear()
    gl.render(scene, cam)
    cam.layers.enable(NO_OUTLINE_LAYER)
    scene.overrideMaterial = override
    scene.background = bg

    cam.position.copy(kept)
    ;[cam.left, cam.right, cam.top, cam.bottom] = frame
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()

    u.uShift.value.set(fx, fy)
    u.uNear.value = cam.near
    u.uFar.value = cam.far
    u.uDepthStep.value = texel * 3
    gl.setRenderTarget(null)
    gl.render(res.quadScene, res.quadCamera)
  }, 1)

  return null
}
