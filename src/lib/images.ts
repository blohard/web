// Re-encode PNG, JPEG and WebP through a canvas to strip source metadata and
// downscale to the host's attachment cap (the protocol spec §7). Other formats
// are handled by attachments.ts; this module does not sanitize them.

const REENCODE = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_SIDE = 2048

/** True for the raster types this re-encodes. */
export function reencodes(mediaType: string): boolean {
  return REENCODE.has(mediaType)
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

/**
 * Pixels only, as `mediaType`, at most `maxBytes` long if the source can be
 * shrunk that far. Downscales in steps and, for lossy types, lowers quality.
 * Returns null if decoding or encoding fails, or the result cannot fit.
 */
export async function reencodeImage(file: Blob, mediaType: string, maxBytes: number): Promise<Uint8Array | null> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return null
  }
  try {
    let scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
    const lossy = mediaType !== 'image/png'
    for (let attempt = 0; attempt < 8; attempt++) {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      if (mediaType === 'image/jpeg') {
        // JPEG has no alpha: transparent areas would otherwise turn black.
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const quality = lossy ? Math.max(0.5, 0.92 - attempt * 0.08) : undefined
      const blob = await toBlob(canvas, mediaType, quality)
      if (!blob) return null
      if (blob.size <= maxBytes) return new Uint8Array(await blob.arrayBuffer())
      scale *= 0.75
    }
    return null
  } finally {
    bitmap.close()
  }
}
