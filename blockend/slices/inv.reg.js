/** *                  *
 *   .  *
 *  /¤\       *
 * /___\ [Content Advisory Warning]
 *
 * Read at your own risk.
 * This file shortcircuits the left with the right
 * causing loss of sanity for the legally inclined.
 */
const {
  btok,
  decodeBlock,
  EV_CHAT_END,
  TYPE_VIBE_RESP,
  VIBE_REJECTED
} = require('../util')
const assert = require('nanoassert')
const { ACTIVE, stateOfPeer } = require('./peers.reg')
const Transactions = require('../transactions')
const BARPK = Buffer.from('vjbtsM2BFee1ExqsUJsJaoWLj8hXENll2/ePLeLz9c0=', 'base64')
const TYPE_ITEMS = 'items'

// Shit this is so confusing already.
function InventorySlice () {
  return {
    name: 'inv',
    initialValue: {},

    filter ({ block, root, state, HEAD }) {
      const data = decodeBlock(block.body)
      if (data.type !== TYPE_ITEMS) return true

      const pid = btok(HEAD)
      const peer = root.peers[pid]
      const pState = stateOfPeer(peer, root.vibes, root.chats)
      const hasBarItems = data.items.find(i => i.id < 0xD200)
      if (hasBarItems && !block.key.equals(BARPK)) return 'StampNotTrusted'
      if (pState !== ACTIVE) return 'PeerBusy'
      if (Date.now() - data.date >= 60 * 60 * 1000) return 'DeliveryTimeout'
      return false
    },

    reducer ({ block, state, schedule, HEAD }) {
      const pid = btok(HEAD)
      const data = decodeBlock(block.body)
      // initialize peer inventory
      const inv = initInv(state, pid)
      for (const item of data.items) {
        const slot = initSlot(inv, item.id)
        slot.qty++
        slot.expiresAt = item.expiresAt
        // TODO: schedule perishables to expire
        /*
        if (item.expiresAt) {
          schedule(item.expiresAt, `item|${item.id}|${pid}`)
        }
        */
      }
      return state
    },

    trap ({ code, payload, root, state }) {
      if (!EV_CHAT_END) return
      const cid = btok(payload)
      const pending = root.trs[cid]
      if (!pending?.length) return
      for (const op of pending) {
        const inv = initInv(state, btok(op.target))
        const slot = initSlot(inv, op.item)
        slot.qty += op.qty
      }
      return state
    }
  }
}

function initInv (state, pid) {
  state[pid] = state[pid] || {}
  return state[pid]
}

function initSlot (inv, id) {
  inv[id] = inv[id] || {
    id, // item id
    qty: 0,
    activatedAt: -1,
    expiresAt: -1
  }
  return inv[id]
}

// A slice holding pending transactions
// and applying them on successfull timelock break
function TransactionsSlice () {
  return {
    name: 'trs',
    initialValue: {
    },

    filter ({ block, parentBlock, root, state }) {
      const { type, box } = decodeBlock(block.body)

      if (type !== TYPE_VIBE_RESP) return true
      const rejected = VIBE_REJECTED.equals(box)
      if (rejected) return true
      const { t: transactions } = decodeBlock(parentBlock.body)
      try {
        for (const ta of transactions) {
          const { t: type, p: payload } = Transactions.validate(ta)
          switch (type) {
            case Transactions.ACTION_OFFER: {
              const sourcePid = btok(parentBlock.key)
              const inv = root.inv[sourcePid]
              assert(inv, 'InventoryEmpty')
              const item = inv[payload.i]
              assert(item, 'ItemNotHeld')
              assert(item.qty - payload.q >= 0, 'NegativeQuantity')
            } break
          }
        }
      } catch (err) { return err.message }

      return false
    },

    reducer ({ block, parentBlock, root, state }) {
      const cid = btok(parentBlock.sig)
      const { t: transactions } = decodeBlock(parentBlock.body)
      const pending = state[cid] = []
      for (const { t: type, p: payload } of transactions) {
        switch (type) {
          case Transactions.ACTION_CONJURE_WATER:
            pending.push({
              item: 0xD700, // TODO: replace with Items.Water
              qty: 1,
              target: parentBlock.key
            })
            break
          case Transactions.ACTION_OFFER:
            pending.push({
              item: payload.i,
              qty: payload.q,
              target: block.key
            })
            pending.push({
              item: payload.i,
              qty: -payload.q,
              target: parentBlock.key
            })
        }
      }
      return state
    },

    trap ({ code, payload, root, state }) {
      if (!EV_CHAT_END) return
      const cid = btok(payload)
      delete state[cid]
      return state
    }
  }
}

module.exports = {
  InventorySlice,
  TransactionsSlice
}