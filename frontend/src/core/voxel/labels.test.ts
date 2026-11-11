import { expect, it } from 'vitest'
import { wheelCopy } from './labels'

it('hands a wheel over a label on to the map with the same place, amount and keys', () => {
  const e = {
    clientX: 120, clientY: 80, screenX: 300, screenY: 260, deltaX: 0, deltaY: -40, deltaZ: 0, deltaMode: 0,
    ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, target: 'label',
  } as unknown as WheelEvent
  expect(wheelCopy(e)).toEqual({
    clientX: 120, clientY: 80, screenX: 300, screenY: 260, deltaX: 0, deltaY: -40, deltaZ: 0, deltaMode: 0,
    ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, bubbles: true, cancelable: true,
  })
})
