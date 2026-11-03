// Whether a key press belongs to the input method, such as the Enter that picks a Chinese word.
//
// isComposing alone is not enough in Safari and WKWebView: they send compositionend before the keydown of the
// key that ends the composition, so that keydown has isComposing false. Its keyCode is still 229, the value for a
// key the input method took. https://bugs.webkit.org/show_bug.cgi?id=165004

export function composing(e: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>) {
  return e.isComposing || e.keyCode === 229
}
