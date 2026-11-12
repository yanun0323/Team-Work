import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Look } from '../domain/types'
import { seedOf, styleOf } from '../../figureStyle'
import { facePixels, faceUrl, PixelFace } from './PixelFace'

const look: Look = { skin: '#f1c7a5', hair: '#3b2a20', shirt: '#4a7bd0', pants: '#2c3444', extra: 'cap', style: 7, wardrobe: 2 }

/** The SVG document behind a face's address. */
const svgOf = (url: string) => decodeURIComponent(url.slice(url.indexOf(',') + 1))

describe('faceUrl', () => {
  it('draws every rectangle of the face, in its colours, as one picture', () => {
    const svg = svgOf(faceUrl(look, 'Ada'))
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 10 10" shape-rendering="crispEdges">/)
    expect(svg.match(/<rect /g)).toHaveLength(facePixels(look.extra, styleOf(7, 2)).length)
    expect(svg).toContain(`fill="${look.skin}"`)
    // the cap is the shirt's colour
    expect(svg).toContain(`fill="${look.shirt}"`)
  })

  it('draws the same face for the same look, whatever the name, and follows the look as it changes', () => {
    const url = faceUrl(look, 'Ada')
    expect(faceUrl({ ...look }, 'Bea')).toBe(url)
    expect(faceUrl({ ...look, hair: '#000000' }, 'Ada')).not.toBe(url)
    expect(faceUrl({ ...look, extra: 'none' }, 'Ada')).not.toBe(url)
  })

  it('takes the cut from the name when the look has no style of its own, as the 3D figure does', () => {
    const unseeded = { ...look, style: undefined }
    expect(faceUrl(unseeded, 'Ada')).toBe(faceUrl({ ...look, style: seedOf('Ada') }, 'Bea'))
  })
})

describe('PixelFace', () => {
  it('is a picture named after the person, at its size, of a handful of elements', () => {
    const html = renderToStaticMarkup(<PixelFace look={look} name="Ada" size={34} />)
    expect(html).toMatch(/^<svg class="pixel-face" width="34" height="34" viewBox="0 0 10 10" role="img" aria-label="Ada">/)
    expect(html).toContain('<title>Ada</title>')
    expect(html.match(/<image /g)).toHaveLength(1)
    expect(html).not.toContain('<rect')
    expect(html).toContain(`href="${faceUrl(look, 'Ada')}"`)
  })
})
