// SPDX-License-Identifier: AGPL-3.0-or-later
const Repo = require('picorepo')
const Store = require('@telamon/picostore')
const Feed = require('picofeed')
const { RPC } = require('./rpc')
const PeerCtrl = require('./slices/peers')
const VibeCtrl = require('./slices/vibes')
const ConversationCtrl = require('./slices/chats')
const {
  KEY_SK,
  KEY_BOX_LIKES_PK,
  KEY_BOX_LIKES_SK,
  TYPE_PROFILE,
  TYPE_VIBE,
  TYPE_VIBE_RESP,
  TYPE_MESSAGE,
  VIBE_REJECTED,
  PASS_TURN,
  decodeBlock,
  encodeBlock,
  boxPair,
  seal,
  unseal,
  toBuffer
} = require('./util')
const debug = require('debug')
const D = debug('picochat:Kernel')

// debug.enable('pico*')

class Kernel {
  constructor (db) {
    this.db = db
    this.repo = new Repo(db)
    this.store = new Store(this.repo, mergeStrategy)

    // Setup slices
    this.store.register(PeerCtrl.ProfileCtrl(() => this.pk))
    this.store.register(PeerCtrl()) // Register PeerStore that holds user profiles
    this._vibeController = new VibeCtrl() // TODO: return { resolveKeys: fn, controller: fn }
    this.store.register(this._vibeController)
    this.store.register(ConversationCtrl())
  }

  /**
   * Restores session/data from store
   * returns {boolean} true if user exists
   */
  load () {
    // Experimental anti-pattern
    const deferredLoad = async () => {
      try {
        this._sk = await this.repo.readReg(KEY_SK)
      } catch (err) {
        if (!err.notFound) throw err
        else return false // short-circuit empty store / no identity
      }
      if (this._sk) {
        this._vibeBox = {
          sk: await this.repo.readReg(KEY_BOX_LIKES_SK),
          pk: await this.repo.readReg(KEY_BOX_LIKES_PK)
        }
        this._vibeController.setKeys(this.pk, this._vibeBox)
      }
      await this.store.load() // returns notification
      return !!this._sk
    }
    if (!this.__loading) this.__loading = deferredLoad()
    return this.__loading
  }

  /**
   * Returns user's public key (same thing as userId)
   */
  get pk () {
    return this._sk?.slice(32)
  }

  /**
   * Generates a new user identity and creates the first profile block
   */
  async register (profile) {
    // Signing identity
    const { sk } = Feed.signPair()
    this._sk = sk

    // A box for love-letters
    const box = boxPair()
    this._vibeBox = box
    this._vibeController.setKeys(this.pk, this._vibeBox)

    await this.updateProfile(profile)
    await this.repo.writeReg(KEY_SK, sk)
    await this.repo.writeReg(KEY_BOX_LIKES_PK, box.pk)
    await this.repo.writeReg(KEY_BOX_LIKES_SK, box.sk)
  }

  /**
   * Creates a new profile-block
   */
  async updateProfile (profile) {
    return await this._createBlock(TYPE_PROFILE, {
      ...profile,
      box: this._vibeBox.pk
    })
  }

  /**
   * Get user's profile from store
   */
  get profile () {
    return this.store.state.peers[this.pk.toString('hex')]
  }

  /**
   * Returns user's personal feed
   * - *optional* limit {number} limit amount of blocks fetched.
   */
  async feed (limit = undefined) {
    this._checkReady()
    return this.repo.loadHead(this.pk, limit)
  }

  /**
   * Returns boolean if kernel has a user
   * e.g. isLoggedIn
   */
  get ready () {
    return !!this._sk
  }

  /**
   * Helper that throws error if kernel is not ready
   */
  _checkReady () {
    if (!this.ready) throw new Error('Kernel is not ready, still loading or user is not registerd')
  }

  /**
   * Returns the last block number of user
   * Block sequence starts from 0 and increments by 1 for each new user-block
   */
  async seq () {
    const feed = await this.feed(1)
    if (!feed) return -1
    return decodeBlock(feed.last.body).seq
  }

  /**
   * Sends a vibe to a peer giving initiating a private
   * channel for communication.
   * params:
   * - peerId {SignaturePublicKey} a peer's signing key
   */
  async sendVibe (peerId) {
    peerId = toBuffer(peerId)
    if (this.pk.equals(peerId)) throw new Error('SelfVibeNotAllowed')
    const msgBox = boxPair()
    const peer = await this.profileOf(peerId)
    const sealedMessage = seal(msgBox.pk, peer.box)
    const convo = await this._createBlock(TYPE_VIBE, {
      box: sealedMessage
    })
    const chatId = convo.last.sig
    await this._storeLocalChatKey(chatId, msgBox)
    // Store target ref
    const key = Buffer.allocUnsafe(Feed.SIGNATURE_SIZE + 1)
    chatId.copy(key, 1)
    key[0] = 84 // ASCII: 'T'
    await this.repo.writeReg(key, peer.pk)
    return chatId
  }

  /**
   * Responds to a vibe by generating the second box pair
   * params:
   * - chatId {BlockSignature} id of the initial vibe-block.
   */
  async respondVibe (chatId, like = true) {
    chatId = toBuffer(chatId)
    const msgBox = boxPair()

    if (!this.store.state.vibes.own.find(v => v.equals(chatId))) throw new Error('NotYourVibe')

    const vibe = this.store.state.vibes.matches[chatId.toString('hex')]
    if (!vibe) throw new Error('VibeNotFound')
    const peer = await this.profileOf(vibe.a)

    if (!peer) throw new Error('PeerNotFound')
    const sealedMessage = seal(msgBox.pk, peer.box)

    const block = await this.repo.readBlock(chatId)
    const convo = await this._createBlock(Feed.from(block), TYPE_VIBE_RESP, {
      box: !like ? VIBE_REJECTED : sealedMessage
    })
    if (!convo) throw new Error('Failed creating block')
    if (like) await this._storeLocalChatKey(vibe.chatId, msgBox)
  }

  /**
   * Creates a new block on parent feed and dispatches it to store
   *
   * - branch {Feed} the parent feed, OPTIONAL! defaults to user's private feed.
   * - type {string} (block-type: 'profile' | 'box' | 'message')
   * - payload {object} The data contents
   * returns list of modified stores
   */
  async _createBlock (branch, type, payload) {
    if (typeof branch === 'string') return this._createBlock(null, branch, type)
    this._checkReady() // Abort if not ready

    // Use provided branch or fetch user's feed
    // if that also fails then initialize a new empty Feed.
    branch = branch || (await this.feed()) || new Feed()

    const seq = (await this.seq()) + 1 // Increment block sequence
    const data = encodeBlock(type, seq, payload) // Pack data into string/buffer
    branch.append(data, this._sk) // Append data on selected branch

    const mut = await this.dispatch(branch, true) // Dispatch last block to store
    if (!mut.length) throw new Error('CreateBlock failed: rejected by store')
    if (this._badCreateBlockHook) this._badCreateBlockHook(branch.slice(-1))
    return branch
  }

  async profileOf (key) {
    /*
    const tail = await this.repo.tailOf(key)
    const block = await this.repo.readBlock(tail)
    if (!block) throw new Error('Profile not found, error due to profileOf is WIP; Need multihead resolve + network query')
    if (!key.equals(block.key)) throw new Error('Wrong profile encountered')
    const profile = decodeBlock(block.body)
    if (profile.type !== TYPE_PROFILE) throw new Error('Tail is not a profile: ' + profile.type)
    */
    key = toBuffer(key)
    if (!key) throw new Error(`PublicKey expected got "${key}"`)
    const profile = this.store.state.peers[key.toString('hex')]
    if (!profile) {
      // debugger
      throw new Error('ProfileNotFound')
    }
    return profile
  }

  // the other kind of store
  vibes (sub) {
    return this.store.on('vibes', ({ sent, received, own, matches }) => {
      const tasks = []
      const vibes = []
      for (const chatId of own) {
        const match = matches[chatId.toString('hex')]
        const initiator = this.pk.equals(match.a)
        const out = {
          ...initVibe(chatId),
          updatedAt: match.updatedAt,
          createdAt: match.createdAt,
          box: match.remoteBox,
          initiator: initiator ? 'local' : 'remote',
          localRejected: initiator && match.state === 'rejected',
          remoteRejected: !initiator && match.state === 'rejected',
          head: match.response
        }

        if (match.state === 'rejected') out.state = 'rejected'
        else if (match.a && match.b) out.state = 'match'
        else if (!initiator && !match.b) out.state = 'waiting_local'
        else if (initiator && !match.b) out.state = 'waiting_remote'
        else out.state = 'mental_error'
        // The 3 lines above can be replaced with: state = !initiator ? 'waiting_local' : 'waiting_remote'
        // given that there are no mental errors...

        // INNER JOIN profile on vibe
        // Attempt to remember who we sent what to.
        if (initiator) {
          const key = Buffer.allocUnsafe(Feed.SIGNATURE_SIZE + 1)
          chatId.copy(key, 1)
          key[0] = 84 // ASCII: 'T'
          tasks.push(
            this.repo.readReg(key)
              .then(pk => this.profileOf(pk))
              .then(peer => { out.peer = peer })
          )
        } else {
          tasks.push(
            this.profileOf(match.a)
              .then(p => { out.peer = p })
          )
        }
        vibes.push(out)
      }

      // When all tasks finish invoke subscriber
      Promise.all(tasks)
        .then(() => sub(vibes))
        .catch(err => {
          console.error('Error occured during vibes derivation:', err)
          throw err
        })
    })

    function initVibe (id, peer, date) {
      return {
        id,
        peer,
        box: null,
        fetchPair: null,
        state: 'waiting',
        updatedAt: 0,
        createdAt: Infinity,
        remoteRejected: false,
        localRejected: false,
        head: null
      }
    }
  }

  /*
   * A reactive store whose value is conversation object
   * containing all then necesarry tidbits and bound actions
   * to progress the conversation
   */
  getChat (chatId, subscriber) {
    chatId = toBuffer(chatId)
    let head = chatId
    let localPair = null
    // Actions
    const send = async (message, pass = false) => {
      if (!chat.myTurn) throw new Error('NotYourTurn')
      if (!pass && typeof message !== 'string') throw new Error('Message should be a string')
      if (!pass && !message.length) throw new Error('EmptyMessage')
      // const { sk } = await this._getLocalChatKey(chatId) // Local Secret Key
      const pk = await this._getRemoteChatKey(chatId) // Remote Public Key
      const kHead = this.store.state.chats.chats[chatId.toString('hex')]?.head
      const branch = await this.repo.loadFeed(kHead || head)

      const content = pass ? PASS_TURN : seal(toBuffer(message), pk)
      await this._createBlock(branch, TYPE_MESSAGE, { content })
      // Branch "hopefully" contains new block, if not use return of createBlock() in future
      if (!pass) await this._setMessageBody(branch.last.sig, message)
    }
    const pass = async () => {
      if (!chat.myTurn) throw new Error('NotYourTurn')
      return send(0, true)
    }
    const bye = async () => {} // TODO: black magic

    // State
    let dirty = true
    const chat = {
      id: chatId,
      state: 'init',
      myTurn: true,
      mLength: 0,
      messages: [],
      updatedAt: 0,
      createdAt: 0,
      remoteBox: null,
      send,
      pass,
      bye
    }

    const vibesUnsub = this.vibes(vibes => {
      const vibe = vibes.find(v => chatId.equals(v.id))
      // All conversations must start with a vibe
      if (!vibe) set({ state: 'error', message: 'VibeNotFound' })
      head = vibe.head
      if (vibe.state === 'match') set({ state: 'active' })
      else if (vibe.state === 'rejected') set({ state: 'inactive' })
      set({
        updatedAt: Math.max(chat.updatedAt, vibe.updatedAt),
        createdAt: vibe.createdAt,
        remoteBox: vibe.remoteBox
      })
      if (!chat.mLength && vibe.state === 'match') {
        // First to vibe is first to write
        set({ myTurn: vibe.initiator === 'local' })
        vibesUnsub() // Once a vibe reaches state match it will no longer update.
      }
      notify()
    })

    const subs = [
      vibesUnsub,
      this.store.on('chats', state => {
        // If head of an owned conversation was updated, then set and notify
        const low = state.chats[chatId.toString('hex')] // lowlevel chat
        if (!low) return
        const myTurn = !((low.mLength % 2) ^ (this.pk.equals(low.b) ? 1 : 0))
        // Update headers
        set({
          state: low.state,
          updatedAt: low.updatedAt,
          mLength: low.mLength,
          head: low.head,
          myTurn
        })

        if (chat.messages.length === low.messages.length) {
          return notify()
        }

        (async () => {
          if (!localPair) localPair = await this._getLocalChatKey(chatId)
          const unread = []
          for (let i = chat.messages.length; i < low.messages.length; i++) {
            const msg = { ...low.messages[i] }
            head = msg.sig
            if (msg.type === 'received') {
              msg.content = unseal(msg.content, localPair.sk, localPair.pk).toString()
            } else {
              msg.content = await this._getMessageBody(msg.sig)
            }
            unread.push(msg)
          }
          return unread
        })()
          .catch(console.error)
          .then(unread => {
            if (unread && unread.length) set({ messages: [...chat.messages, ...unread] })
            notify()
          })
      })
    ]

    return () => { for (const unsub of subs) unsub() }
    function notify (force = false) {
      if (!force && !dirty) return
      dirty = false
      subscriber(chat)
    }
    function set (patch) {
      for (const k in patch) {
        if (chat[k] !== patch[k]) dirty = true
        chat[k] = patch[k]
      }
    }
  }

  /**
   * Mutates store and reduced state
   * returns {string[]} names of stores that were modified by this action
   */
  async dispatch (patch, loudFail = false) {
    this._checkReady()
    return await this.store.dispatch(patch, loudFail)
  }

  // ---- Network stuff

  async enter (name) {
    // TODO: Make disposable scoped store
    // this.pub.store = new Store(makeDatabase(name))
    // await this.pub.store.load()
    const repo = this.repo
    const store = this.store

    const rpc = new RPC({
      onblocks: async feed => {
        const mut = await store.dispatch(feed, false)
        return mut.length
      },
      // Lookups and read hit the permanent store first and then secondaries
      queryHead: async key => (await this.repo.headOf(key)) || (await repo.headOf(key)),
      queryTail: async key => (await this.repo.tailOf(key)) || (await repo.tailOf(key)),
      onquery: async params => {
        const keys = Object.values(store.state.peers)
          // experimental
          // .filter(peer => peer.date > new Date().getTime() - 1000 * 60 * 60) // Only peers active last hour
          .sort((a, b) => a.date - b.date) // Newest first or something
          .map(peer => peer.pk)
        const feeds = []
        for (const key of keys) {
          const f = await repo.loadHead(key)
          if (f) feeds.push(f)
        }
        return feeds
      }
    })
    this._badCreateBlockHook = block => rpc.sendBlock(block)

    return (details = {}) => {
      // if (blocklist.contains(details.prop)) return
      return rpc.createWire(send => { // on remote open
        // if (details.client)
        rpc.query(send, {})
      })
    }
  }

  // -- Conversation key management
  async _storeLocalChatKey (chatId, msgBox) {
    const CONVERSATION_PREFIX = 67 // Ascii 'C'
    // const CONVERSATION_PREFIX = 99 // Ascii 'c'
    const vLength = msgBox.sk.length + msgBox.pk.length
    if (vLength !== 64) throw new Error(`Expected box keypair to be 32bytes each, did algorithm change?: ${vLength}`)
    chatId = toBuffer(chatId)
    if (chatId.length !== Feed.SIGNATURE_SIZE) throw new Error('Expected chatId to be a block signature')

    const value = Buffer.allocUnsafe(msgBox.sk.length + msgBox.pk.length)
    msgBox.sk.copy(value)
    msgBox.pk.copy(value, msgBox.sk.length)
    const key = Buffer.allocUnsafe(Feed.SIGNATURE_SIZE + 1)
    chatId.copy(key, 1)
    key[0] = CONVERSATION_PREFIX
    return await this.repo.writeReg(key, value)
  }

  async _getLocalChatKey (chatId) {
    const CONVERSATION_PREFIX = 67 // Ascii 'C'
    if (typeof chatId === 'string') chatId = Buffer.from(chatId, 'hex') // Attempt normalize to buffer
    chatId = toBuffer(chatId)
    if (chatId.length !== Feed.SIGNATURE_SIZE) throw new Error('Expected chatId to be a block signature')

    const key = Buffer.allocUnsafe(Feed.SIGNATURE_SIZE + 1)
    chatId.copy(key, 1)
    key[0] = CONVERSATION_PREFIX
    const value = await this.repo.readReg(key)
    if (!value) throw new Error('BoxPairNotFound')
    const box = {
      pk: value.slice(32),
      sk: value.slice(0, 32)
    }
    return box
  }

  // -- Encrypted messages can only be decrypted by receiver
  // hence we need to store a copy of each message locally (might add some local encryption to it later)
  async _getRemoteChatKey (chatId) {
    const key = chatId.toString('hex')
    const vibe = this.store.state.vibes.matches[key]
    if (!vibe) throw new Error('ConversationNotFound')
    if (!vibe.remoteBox) throw new Error('BoxPublicKeyNotAvailable')
    return vibe.remoteBox
  }

  async _setMessageBody (chatId, message) {
    const CONVERSATION_PREFIX = 77 // Ascii 'M'
    chatId = toBuffer(chatId)
    if (chatId.length !== Feed.SIGNATURE_SIZE) throw new Error('Expected chatId to be a block signature')
    const key = Buffer.allocUnsafe(Feed.SIGNATURE_SIZE + 1)
    chatId.copy(key, 1)
    key[0] = CONVERSATION_PREFIX
    return await this.repo.writeReg(key, toBuffer(message))
  }

  async _getMessageBody (chatId) {
    const CONVERSATION_PREFIX = 77 // Ascii 'M'
    chatId = toBuffer(chatId)
    if (chatId.length !== Feed.SIGNATURE_SIZE) throw new Error('Expected chatId to be a block signature')
    const key = Buffer.allocUnsafe(Feed.SIGNATURE_SIZE + 1)
    chatId.copy(key, 1)
    key[0] = CONVERSATION_PREFIX
    const msg = await this.repo.readReg(key)
    if (!msg) throw new Error('MessageNotFound')
    return msg.toString()
  }
}

// This function is called by repo when a non-linear block is encountered
async function mergeStrategy (block, repo) { // TODO: expose loudFail flag? mergStr(b, r, !dryMerge && loud)
  const content = decodeBlock(block.body)
  const { type } = content
  // Allow VibeResponses to be merged onto foreign vibes
  if (type === TYPE_VIBE_RESP) {
    const pBlock = await repo.readBlock(block.parentSig)
    const pContent = decodeBlock(pBlock.body)
    if (pContent.type !== TYPE_VIBE) return false
    if (!VIBE_REJECTED.equals(content.box)) {
      D(`Match detected: ${block.key.slice(0, 4).toString('hex')} <3 ${pBlock.key.slice(0, 4).toString('hex')}`)
    } else {
      D(`Rejection detected: ${block.key.slice(0, 4).toString('hex')} </3 ${pBlock.key.slice(0, 4).toString('hex')}`)
    }
    return true // All good, merge permitted
  }

  // Allow Messages onto foreign VibeResponses or Messages
  if (type === TYPE_MESSAGE) {
    // debugger
  }
  console.warn('MergeStrategy rejected', type, block.key.toString('hex').slice(0, 10))
  return false // disallow by default
}
module.exports = Kernel
