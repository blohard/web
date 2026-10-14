/** Native modal focus handling, with background scrolling restored on dismissal or navigation. */
export function modal(dialog: HTMLDialogElement, onclose: () => void) {
  const root = document.documentElement
  const overflow = root.style.overflow
  const from = document.activeElement
  dialog.showModal()
  root.style.overflow = 'hidden'
  return {
    destroy() {
      dialog.close()
      onclose()
      root.style.overflow = overflow
      if (from instanceof HTMLElement && from.isConnected) from.focus({ preventScroll: true })
    },
  }
}
