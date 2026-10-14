/** Keep links and image lightboxes inside the draft preview from opening another view. */
export function blockPreviewNavigation(event: Event) {
  if (event.type === 'keydown' && !['Enter', ' '].includes((event as KeyboardEvent).key)) return
  if (event.target instanceof Element && event.target.closest('a, img')) {
    event.preventDefault()
    event.stopPropagation()
  }
}
