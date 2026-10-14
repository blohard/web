// Device hints choose whether an ordinary browser can use the mobile wallet SDK.

export function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { userAgentData?: { mobile: boolean } }
  return !!(nav.userAgentData?.mobile
    || /Android|iPhone|iPad|iPod/i.test(nav.userAgent)
    // iPads can report a desktop user agent.
    || (/Macintosh/i.test(nav.userAgent) && nav.maxTouchPoints > 1))
}
