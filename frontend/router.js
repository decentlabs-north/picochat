import { writable, gate, mute } from '../blockend/nuro'
import { svlt } from './api'

// Import Views
import Keygen from './views/Keygen.svelte'
import Pub from './views/Pub.svelte'
import Profile from './views/Profile.svelte'
import Shop from './views/Shop.svelte'
import Messages from './views/Messages.svelte'
import Chat from './views/Chat.svelte'
import About from './views/About.svelte'

const [$name, setName] = writable()
const [$id, setId] = writable()
// map name to component
const $view = gate(mute($name, name => {
  switch (name) {
    case 'pub': return Pub
    case 'shop': return Shop
    case 'msgs': return Messages
    case 'profile': return Profile
    case 'chat': return Chat
    case 'about': return About
    case 'keygen': default: return Keygen
  }
}))

// -----------------------------------------
// Internal router code
// (just pretend it's not here)
// ----------------------------------------
export const routeName = svlt($name)
export const view = svlt($view)
export const id = svlt($id)

let current = null
export function setView (path, id) {
  if (current && path === current) return false
  current = path
  // console.info('Rerouting to path:', path, 'id:', id)
  setName(path)
  setId(id)
}
function apply () {
  const [path, id] = window.location.hash.replace(/^#\/?/, '').toLowerCase().split('/')
  setView(path, id)
}
export function navigate (path) {
  window.history.pushState(null, null, `/#${path}`.replace(/^#\/+/, '#/'))
  apply()
}
window.addEventListener('popstate', apply)
apply()