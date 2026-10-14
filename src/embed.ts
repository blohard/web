// The discussion widget: one thread of this host, shown inside another site's
// page through an iframe (public/embed.js puts the frame there). Same app,
// same modules, without the app's chrome.
import { mount } from 'svelte'
import './app.css'
import Embed from './features/embed/Embed.svelte'
import { router } from './features/navigation/router.svelte'

// Inside the frame, every in-app link opens the full app in a new tab.
router.embed = true

// The page around the frame may ask for one palette so the frame matches it;
// otherwise the frame follows the reader's system like the app does.
const theme = new URLSearchParams(location.search).get('theme')
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme

export default mount(Embed, { target: document.getElementById('embed')! })
