const ClpNode = require('../clp-node')
const ClpPacket = require('clp-packet')
const IlpPacket = require('ilp-packet')
const crypto = require('crypto')

function generateRequestId() {
 const buf = crypto.randomBytes(4)
 const hex = buf.toString('hex')
 return parseInt(hex, 16)
}

function MakeProtocolData(obj) {
  let protocolData = [
    {
      protocolName: 'from',
      contentType: ClpPacket.MIME_TEXT_PLAIN_UTF8,
      data: Buffer.from(obj.from, 'ascii')
    },
    {
      protocolName: 'to',
      contentType: ClpPacket.MIME_TEXT_PLAIN_UTF8,
      data: Buffer.from(obj.to, 'ascii')
    }
  ]
  if (obj.ilp) {
    protocolData.push({
      protocolName: 'ilp',
      contentType: ClpPacket.MIME_APPLICATION_OCTET_STREAM,
      data: Buffer.from(obj.ilp, 'base64')
    })
  } else {
    protocolData.push({
      protocolName: 'ccp',
      contentType: ClpPacket.MIME_APPLICATION_JSON,
      data: Buffer.from(JSON.stringify(obj.custom), 'ascii')
    })
  }
  return protocolData
}
 
function Frog (config) {
  this.plugin = config.plugin
  this.registerPluginEventHandlers()
  this.requestsReceived = {}
  this.node = new ClpNode(config.clp, (whoAmI, baseUrl, urlPath) => {
    if (this.url) {
      console.warn(`WARNING: New peer (${ baseUrl + urlPath }) will now kick out earlier peer (${ this.url })`)
    }
    this.url = baseUrl + urlPath
  }, this.handleWebSocketMessage.bind(this))
}

Frog.prototype = {
  registerPluginEventHandlers() {
    this.plugin.on('incoming_prepare', (transfer) => {
      // console.log('incoming prepare!', transfer)
      try {
        this.node.send(this.url, ClpPacket.serialize({
          type: ClpPacket.TYPE_PREPARE,
          requestId: generateRequestId(),
          data: {
            transferId: transfer.id,
            expiresAt: new Date(transfer.expiresAt),
            amount: parseInt(transfer.amount),
            executionCondition: Buffer.from(transfer.executionCondition, 'base64'),
            protocolData: MakeProtocolData(transfer)
          }
        }))
      } catch(e) {
        console.error(e)
      }
    })
    this.plugin.registerRequestHandler((request) => { 
      const promise = new Promise((resolve, reject) => {
        this.requestsReceived[request.id] = { resolve, reject }
      })
      this.node.send(this.url, ClpPacket.serialize({
        type: ClpPacket.TYPE_MESSAGE,
        requestId: request.id,
        data: MakeProtocolData(request)
      }))
      return promise
    })
    this.plugin.on('outgoing_fulfill', (transfer, fulfillment) => {
      // console.log('our prepare was fulfilled on-ledger!', transfer, fulfillment)
      try {
        this.node.send(this.url, ClpPacket.serialize({
          type: ClpPacket.TYPE_FULFILL,
          requestId: generateRequestId(),
          data: {
            transferId: transfer.id,
            fulfillment: Buffer.from(fulfillment, 'base64'),
            protocolData: []
          }
        }))
      } catch(e) {
        console.error(e)
      }
    })
    this.plugin.on('outgoing_reject', (transfer, rejectionReason) => {
      try {
        this.node.send(this.url, ClpPacket.serialize({
          type: ClpPacket.TYPE_REJECT,
          requestId: generateRequestId(),
          data: {
            transferId: transfer.id,
            rejectionReason,
            protocolData: []
          }
        }))
      } catch(e) {
        console.error(e)
      }
    })
  },

  _handleIlpMessage(obj, protocolDataAsObj) {
    const lpiRequest = {
      id: obj.requestId.toString(),
      from: this.plugin.getAccount(),
      to: protocolDataAsObj.to.data.toString('ascii'),
      ledger: this.plugin.getInfo().prefix,
      ilp: protocolDataAsObj.ilp.data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
      custom: {}
    }
    this.plugin.sendRequest(lpiRequest).then((response) => {
      const responsePacketBuf = Buffer.from(response.ilp, 'base64')
      const ilpResponse = IlpPacket.deserializeIlpPacket(responsePacketBuf)
      const responseProtocolData = MakeProtocolData(response)
      if (ilpResponse.type ===  IlpPacket.TYPE_ILP_ERROR) {
        this.node.send(this.url, ClpPacket.serialize({
          type: ClpPacket.TYPE_ERROR,
          requestId: obj.requestId,
          data: {
            rejectionReason: err,
            protocolData: responseProtocolData
          }
        }))
      } else {
        this.node.send(this.url, ClpPacket.serialize({
          type: ClpPacket.TYPE_RESPONSE,
          requestId: obj.requestId,
          data: MakeProtocolData(response)
        }))
      }
    }, err => {
      this.node.send(this.url, ClpPacket.serialize({
        type: ClpPacket.TYPE_ERROR,
        requestId: obj.requestId,
        data: {
          rejectionReason: err,
          protocolData: []
        }
      }))
    })
  },

  _handleInfoMessage(obj, protocolDataAsObj) {
    if (obj.data[0].data[0] === 0) {
      this.node.send(this.url, ClpPacket.serialize({
        type: ClpPacket.TYPE_RESPONSE,
        requestId: obj.requestId,
        data: [
          {
            protocolName: 'info',
            contentType: ClpPacket.MIME_TEXT_PLAIN_UTF8,
            data: Buffer.from(this.plugin.getAccount(), 'ascii')
          }
        ]
      }))
    } else {
      this.node.send(this.url, ClpPacket.serialize({
        type: ClpPacket.TYPE_RESPONSE,
        requestId: obj.requestId,
        data: [
          {
            protocolName: 'info',
            contentType: ClpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify(this.plugin.getInfo()), 'ascii')
          }
        ]
      }))
    }
  },

  _handleBalanceMessage(obj, protocolDataAsObj) {
    this.plugin.getBalance().then(decStr => {
      let hexStr = parseInt(decStr).toString(16)
      if (hexStr.length % 2 === 1) {
        hexStr = '0' + hexStr
      }
      let balanceBuf = Buffer.from(hexStr, 'hex')
      while (balanceBuf.length < 8) {
        balanceBuf = Buffer.concat([ Buffer.from([ 0 ]), balanceBuf ])
      }
      this.node.send(this.url, ClpPacket.serialize({
        type: ClpPacket.TYPE_RESPONSE,
        requestId: obj.requestId,
        data: [
          {
            protocolName: 'balance',
            contentType: ClpPacket.MIME_APPLICATION_OCTET_STREAM,
            data: balanceBuf
          }
        ]
      }))
    })
  },

  _handleMessage(obj, protocolDataAsObj) {
    switch (obj.data[0].protocolName) {
      case 'ilp':
        return this._handleIlpMessage(obj, protocolDataAsObj)
        break
      case 'info':
        return this._handleInfoMessage(obj, protocolDataAsObj)
        break
      case 'balance':
        return this._handleBalanceMessage(obj, protocolDataAsObj)
        break
    }
  },

  handleWebSocketMessage(buf) {
    try {
      const obj = ClpPacket.deserialize(buf)
      // console.log('message reached frog over CLP WebSocket!', obj)
      let protocolDataAsObj = {}
      let protocolDataAsArr
      if ([ClpPacket.TYPE_ACK, ClpPacket.TYPE_RESPONSE, ClpPacket.TYPE_MESSAGE].indexOf(obj.type) !== -1) {
        protocolDataAsArr = obj.data
      } else {
        protocolDataAsArr = obj.data.protocolData
      }
      for (let i = 0; i < protocolDataAsArr.length; i++) {
        protocolDataAsObj[protocolDataAsArr[i].protocolName] = protocolDataAsArr[i]
      }
      switch (obj.type) {
        case ClpPacket.TYPE_ACK:
          // If it's a response to sendRequest, then resolve it:
          if (this.requestsReceived[obj.requestId]) {
            this.requestsReceived[obj.requestId].resolve()
            delete this.requestsSent[obj.requestId]
          }
          break
        case ClpPacket.TYPE_RESPONSE:
          // If it's a response to sendRequest, then resolve it:
          if (this.requestsReceived[obj.requestId]) {
            if (Array.isArray(obj.data) && obj.data.length) {
              this.requestsReceived[obj.requestId].resolve(obj.data[0])
            } else { // treat it as an ACK, see https://github.com/interledger/rfcs/issues/283
              this.requestsReceived[obj.requestId].resolve()
            }
            delete this.requestsSent[obj.requestId]
          }
          break

        case ClpPacket.TYPE_ERROR:
          // If it's a response to sendRequest, then resolve it:
          if (this.requestsReceived[obj.requestId]) {
            // according to LPI, an error response should fulfill (not reject) the request handler promise
            this.requestsReceived[obj.requestId].fulfill(obj.data.rejectionReason)
            delete this.requestsSent[obj.requestId]
          }
          break

        case ClpPacket.TYPE_PREPARE:
          const lpiTransfer = {
            id: obj.data.transferId.toString(),
            from: this.plugin.getAccount(),
            to: protocolDataAsObj.to.data.toString('ascii'),
            ledger: this.plugin.getInfo().prefix,
            amount: obj.data.amount.toString(),
            ilp: protocolDataAsObj.ilp.data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
            noteToSelf: {},
            executionCondition: obj.data.executionCondition.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
            expiresAt: obj.data.expiresAt.toISOString(),
            custom: {}
          }
          // console.log('preparing on-ledger', lpiTransfer)
          try {
            this.plugin.sendTransfer(lpiTransfer).then(result => {
              // console.log('prepared', result)
            }, err => {
              console.error(err)
            })
          } catch(e) {
            console.error(e)
          }
          break

        case ClpPacket.TYPE_FULFILL:
          const fulfillmentBase64 = obj.data.fulfillment.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
          this.plugin.fulfillCondition(obj.data.transferId, fulfillmentBase64).then(() => {
            this.node.send(this.url, ClpPacket.serialize({
              type: ClpPacket.TYPE_ACK,
              requestId: obj.requestId,
              data: []
            }))
          }, err => {
            this.node.send(this.url, ClpPacket.serialize({
              type: ClpPacket.TYPE_ERROR,
              requestId: obj.requestId,
              data: {
                rejectionReason: Buffer.from(err.message, 'ascii'), // TODO: use the right error object here ...
                protocolData: []
              }
            }))
          })
          break

        case ClpPacket.TYPE_REJECT:
          this.plugin.rejectIncomingTransfer(obj.data.transferId, IlpPacket.deserializeIlpError(obj.data.rejectionReason))
          break

        case ClpPacket.TYPE_MESSAGE:
          this._handleMessage(obj, protocolDataAsObj)
          break
        default:
         // ignore
      }
    } catch(e) {
      console.error(e)
    }
  },

  start() {
    return this.plugin.connect().then(() => {
      return this.node.start()
    })
  },

  stop() {
    return this.plugin.disconnect().then(() => {
      return this.node.stop()
    })
  }
}
module.exports = Frog
