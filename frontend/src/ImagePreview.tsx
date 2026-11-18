import { useState } from 'react'
import { tr } from './core/i18n'

export function ImagePreview({ src, alt, onError }: { src: string; alt: string; onError?: () => void }) {
  const [widthFit, setWidthFit] = useState(false)
  const action = tr(widthFit ? '符合高度' : '符合寬度')
  return <div className="fx-image-preview">
    <button type="button" data-fit={widthFit ? 'width' : 'height'} onClick={() => setWidthFit(!widthFit)}
      aria-label={`${alt} · ${action}`} title={action}>
      <img className="fx-d-image" src={src} alt={alt} onError={onError} />
    </button>
  </div>
}
