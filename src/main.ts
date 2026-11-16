import { mount } from 'svelte'
import './app.css'
import './shared/build'
import App from './App.svelte'

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
