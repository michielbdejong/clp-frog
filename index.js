const WebSocket = require('ws')
const http = require('http')

const FrogPeer = require('./frog-peer')

const letsEncrypt = require('./letsencrypt')

function Frog (config) {
  this.upstreams = []
  this.serversToClose = []
  this.plugins = []
  this.peers = {}
  this.config = config

  this.plugins.push(config.plugin)
}

Frog.prototype = {
  setClpPeer (ws) {
    this.peers.default =  new FrogPeer(plugin, ws)
    return Promise.resolve()
  },

  connectPlugins () {
    let promises = []
    for (let i = 0; i < this.plugins.length; i++) {
      promises.push(this.plugins[i].connect())
    }
    return Promise.all(promises)
  },

  maybeListen () {
    return new Promise((resolve, reject) => {
      if (this.config.clp.tls) { // case 1: use LetsEncrypt => [https, http]
        letsEncrypt('amundsen.michielbdejong.com').then(resolve, reject)
      } else if (typeof this.config.clp.listen !== 'number') { // case 2: don't open run a server => []
        resolve([])
      } else { // case 3: listen without TLS on a port => [http]
        const server = http.createServer((req, res) => {
          res.end('This is a CLP server, please upgrade to WebSockets.')
        })
        server.listen(this.config.clp.listen, resolve([ server ]))
      }
    }).then(servers => {
      // console.log('servers:', servers.length)
      this.serversToClose = servers
      if (servers.length) {
        this.wss = new WebSocket.Server({ server: servers[0] })
        this.serversToClose.push(this.wss)
        this.wss.on('connection', (ws, httpReq) => {
          const parts = httpReq.url.split('/')
          // console.log('client connected!', parts)
          //        0: software, 1: clp, 2: spec, 3: name, 4: token
          // e.g. [ 'ilp-node-3', 'clp', 'v1', 'a7f0e298941b772f5abc028d477938b6bbf56e1a14e3e4fae97015401e8ab372', 'ea16ed65d80fa8c760e9251b235e3d47893e7c35ffe3d9c57bd041200d1c0a50' ]
          const peerId = parts[3]
          // const peerToken = parts[4] // TODO: use this to authorize reconnections
          // console.log('assigned peerId!', peerId)
          this.addClpPeer('downstream', peerId, ws)
        })
      }
    })
  },

  connectToUpstreams () {
    return Promise.all(this.config.clp.upstreams.map(upstreamConfig => {
      const peerName = upstreamConfig.url.replace(/(?!\w)./g, '')
      // console.log({ url: upstreamConfig.url, peerName })
      return new Promise((resolve, reject) => {
        // console.log('connecting to upstream WebSocket', upstreamConfig.url + '/' + this.config.clp.name + '/' + upstreamConfig.token, this.config.clp, upstreamConfig)
        const ws = new WebSocket(upstreamConfig.url + '/' + this.config.clp.name + '/' + upstreamConfig.token, {
          perMessageDeflate: false
        })
        ws.on('open', () => {
          // console.log('creating client peer')
          this.upstreams.push(ws)
          this.addClpPeer('upstream', peerName, ws).then(resolve, reject)
        })
      })
    }))
  },

  start () {
    return Promise.all([
      this.maybeListen(), // .then(() => { console.log('maybeListen done', this.config) }),
      this.connectToUpstreams(), // .then(() => { console.log('connectToUpstreams done', this.config) }),
      this.connectPlugins() // .then(() => { console.log('connectPlugins done', this.config) })
    ])
  },

  stop () {
    // close ws/wss clients:
    let promises = this.upstreams.map(ws => {
      return new Promise(resolve => {
        ws.on('close', () => {
          resolve()
        })
        ws.close()
      })
    })

    // close http, https, ws/wss servers:
    promises.push(this.serversToClose.map(server => {
      return new Promise((resolve) => {
        server.close(resolve)
      })
    }))

    // disconnect plugins:
    promises.push(this.plugins.map(plugin => plugin.disconnect()))
    return Promise.all(promises)
  }
}

module.exports = Frog
