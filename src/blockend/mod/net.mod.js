const D = require('debug')('picochat:mod:net')
const { RPC } = require('../rpc')

module.exports = function NetworkModule () {
  let spawnWire = null
  return {
    async enter (name) {
      if (spawnWire) return spawnWire
      // TODO: Make disposable scoped store
      // this.pub.store = new Store(makeDatabase(name))
      // await this.pub.store.load()
      const repo = this.repo
      const store = this.store

      const rpc = new RPC({
        onblocks: async feed => {
          try {
            D(this.store.state.peer.name, 'received block')
            D(feed.inspect(true))
            const mut = await store.dispatch(feed, false)
            D('Stores mutated', mut)
            return mut.length
          } catch (err) {
            console.warn('Remote block ignored', err)
          }
          return 0
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
          const nBlocks = feeds.reduce((s, f) => f.length + s, 0)
          const nBytes = feeds.reduce((s, f) => f.tail + s, 0)
          D('onquery: replying with %d-feeds containing %d-blocks, total: %dBytes', feeds.length, nBlocks, nBytes)
          return feeds
        }
      })
      this._badCreateBlockHook = block => {
        D(this.store.state.peer.name, 'sharing new block')
        D(block.inspect(true))
        rpc.sendBlock(block)
      }

      spawnWire = (details = {}) => {
        // if (blocklist.contains(details.prop)) return
        return rpc.createWire(send => { // on remote open
          // if (details.client)
          D('Peer connected', details)
          rpc.query(send, {})
        })
      }
      return spawnWire
    }
  }
}
