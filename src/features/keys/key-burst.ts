// A short celebration after a confirmed key purchase: small keys fly out of the
// button, spin, drift down and fade. A confirmed transfer sees its keys off
// instead: a few fly away up and to the right, one after another. A confirmed
// sale shows the ETH coming back: small ETH diamonds rise and fade. Decorative
// only; it never takes clicks, never moves the layout, and is skipped for
// readers who ask for less motion.

export type Particle = { dx: number; dy: number; fall: number; spin: number; delay: number; size: number }

/** More keys for bigger purchases, within bounds. */
export const burstCount = (amount: bigint): number => 5 + Number(amount < 11n ? amount : 11n)

/**
 * Evenly fanned upward (from 200° to 340°, screen angles), with a little
 * jitter so no two bursts look the same. `random` is injectable for tests.
 */
export function particles(count: number, random: () => number = Math.random): Particle[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (200 + 140 * (i + 0.5) / count + (random() - 0.5) * 12) * Math.PI / 180
    const distance = 90 + random() * 80
    return {
      dx: Math.cos(angle) * distance,
      dy: Math.sin(angle) * distance,
      fall: 40 + random() * 40,
      spin: (random() < 0.5 ? -1 : 1) * (180 + random() * 360),
      delay: random() * 90,
      size: 18 + random() * 10,
    }
  })
}

/** A send is quieter than a purchase: a few more keys for bigger transfers. */
export const sendCount = (amount: bigint): number => 2 + Number(amount < 6n ? amount : 6n)

/**
 * Keys leaving one after another, up and to the right (about 320°, screen
 * angles), each pointing where it goes; `spin` is that fixed heading. `random`
 * is injectable for tests.
 */
export function trail(count: number, random: () => number = Math.random): Particle[] {
  return Array.from({ length: count }, (_, i) => {
    const heading = -40 + (random() - 0.5) * 16
    const distance = 220 + random() * 80
    return {
      dx: Math.cos(heading * Math.PI / 180) * distance,
      dy: Math.sin(heading * Math.PI / 180) * distance,
      fall: 0,
      // The key's shaft points up and to the right (-45°) when unrotated.
      spin: heading + 45,
      delay: i * 70,
      size: 16 + random() * 6,
    }
  })
}

/** A few more diamonds for bigger sales. */
export const sellCount = (amount: bigint): number => 3 + Number(amount < 6n ? amount : 6n)

/**
 * ETH diamonds rising from the button, spread a little to either side and
 * rocking gently, one shortly after another. `random` is injectable for tests.
 */
export function rise(count: number, random: () => number = Math.random): Particle[] {
  return Array.from({ length: count }, (_, i) => ({
    dx: (i + 0.5 - count / 2) / count * 110 + (random() - 0.5) * 24,
    dy: -(110 + random() * 70),
    fall: 0,
    spin: (random() - 0.5) * 30,
    delay: i * 60 + random() * 40,
    size: 14 + random() * 6,
  }))
}

const ETH = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
  + '<path d="M12 2 5 12.5 12 16.5 19 12.5Z"/><path d="M5 14 12 22 19 14 12 18Z" opacity=".75"/></svg>'

const KEY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 20 3M16.5 6.5l2.5 2.5M14 9l2 2"/></svg>'

/**
 * Burst from the centre of `origin`. Returns immediately; cleans up after itself.
 * Best effort: it runs inside a confirmed purchase's callback, where a throw would
 * report a failure for a purchase that succeeded, so nothing here may escape.
 */
export function burstKeys(origin: Element, amount: bigint): void {
  try {
    fly(origin, particles(burstCount(amount)), (p) => [
      { transform: 'translate(0,0) rotate(0deg) scale(.4)', opacity: 0 },
      { transform: `translate(${p.dx * .7}px,${p.dy * .7}px) rotate(${p.spin * .5}deg) scale(1)`, opacity: 1, offset: .25 },
      { transform: `translate(${p.dx}px,${p.dy + p.fall}px) rotate(${p.spin}deg) scale(.9)`, opacity: 0 },
    ], 1100, 'cubic-bezier(.2,.7,.4,1)')
  } catch { /* decoration only */ }
}

/** ETH diamonds rising from `origin` after a confirmed sale. Best effort, like `burstKeys`. */
export function sellKeys(origin: Element, amount: bigint): void {
  try {
    fly(origin, rise(sellCount(amount)), (p) => [
      { transform: 'translate(0,0) rotate(0deg) scale(.5)', opacity: 0 },
      { transform: `translate(${p.dx * .2}px,${p.dy * .2}px) rotate(${-p.spin}deg) scale(1)`, opacity: 1, offset: .2 },
      { transform: `translate(${p.dx}px,${p.dy}px) rotate(${p.spin}deg) scale(.8)`, opacity: 0 },
    ], 1000, 'cubic-bezier(.2,.6,.4,1)', ETH, '#627eea')
  } catch { /* decoration only */ }
}

/** See keys off from `origin` after a confirmed transfer. Best effort, like `burstKeys`. */
export function sendKeys(origin: Element, amount: bigint): void {
  try {
    fly(origin, trail(sendCount(amount)), (p) => [
      { transform: `translate(0,0) rotate(${p.spin}deg) scale(.6)`, opacity: 0 },
      { transform: `translate(${p.dx * .08}px,${p.dy * .08}px) rotate(${p.spin}deg) scale(1)`, opacity: 1, offset: .2 },
      { transform: `translate(${p.dx}px,${p.dy}px) rotate(${p.spin}deg) scale(.7)`, opacity: 0 },
    ], 900, 'cubic-bezier(.55,0,.8,.4)')
  } catch { /* decoration only */ }
}

function fly(origin: Element, keys: Particle[], frames: (p: Particle) => Keyframe[], duration: number, easing: string,
  shape = KEY, color = '#b8860b'): void {
  if (typeof window === 'undefined' || !('animate' in Element.prototype)) return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  const box = origin.getBoundingClientRect()
  const layer = document.createElement('div')
  layer.setAttribute('aria-hidden', 'true')
  layer.style.cssText = `position:fixed;left:${box.left + box.width / 2}px;top:${box.top + box.height / 2}px;`
    + `width:0;height:0;z-index:60;pointer-events:none;color:${color}`
  document.body.append(layer)
  // A timer, not the animations' promises: it also runs if an animation is cancelled or one throws.
  setTimeout(() => layer.remove(), 1600)
  for (const p of keys) {
    const key = document.createElement('span')
    key.innerHTML = shape
    key.style.cssText = `position:absolute;left:${-p.size / 2}px;top:${-p.size / 2}px;width:${p.size}px;height:${p.size}px;display:block`
    layer.append(key)
    key.animate(frames(p), { duration, delay: p.delay, easing, fill: 'both' })
  }
}
