// The blohard discussion widget. Paste where the discussion should appear:
//
//   <script src="https://blohard.social/embed.js" data-post="810337/5"></script>
//
// data-post is "<chain id>/<post id>" of the post whose replies are the
// discussion: write that post from the app, then copy the two numbers from
// its address. Optional: data-host="https://another.host" to read through a
// different host than the one serving this script; data-target="#selector"
// to put the frame inside an element instead of right after the script tag;
// data-theme="light" or "dark" to match the page instead of the reader's
// system setting.
(() => {
  const script = document.currentScript
  if (!script) return
  const host = (script.dataset.host || new URL(script.src).origin).replace(/\/+$/, '')
  const [chain, post] = (script.dataset.post || '').split('/')
  if (!/^\d+$/.test(chain || '') || !/^\d+$/.test(post || '')) {
    console.error('blohard embed: data-post must be "<chain id>/<post id>"')
    return
  }
  const theme = script.dataset.theme === 'light' || script.dataset.theme === 'dark' ? `&theme=${script.dataset.theme}` : ''
  const frame = document.createElement('iframe')
  frame.src = `${host}/embed.html?chain=${chain}&post=${post}${theme}`
  const origin = new URL(frame.src).origin
  frame.title = 'discussion'
  frame.loading = 'lazy'
  frame.referrerPolicy = 'strict-origin'
  frame.style.cssText = 'display:block;width:100%;min-height:5rem;border:0;color-scheme:light dark'
  const target = script.dataset.target ? document.querySelector(script.dataset.target) : null
  if (target) target.append(frame)
  else script.insertAdjacentElement('afterend', frame)
  window.addEventListener('message', (e) => {
    if (e.origin !== origin || e.source !== frame.contentWindow) return
    const d = e.data
    if (d && d.type === 'blohard:height' && typeof d.height === 'number' && Number.isFinite(d.height) && d.height > 0) frame.style.height = `${Math.ceil(d.height)}px`
  })
})()
