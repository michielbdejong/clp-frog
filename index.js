const ClpNode = require('../clp-node')
const ClpPacket = require('clp-packet')
const IlpPacket = require('ilp-packet')

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
  this.node = new ClpNode(config.clp, (ws) => {
    this.ws = ws
    this.registerWebSocketMessageHandler()
  })
}

Frog.prototype = {
  registerPluginEventHandlers() {
    this.plugin.on('incoming_prepare', (transfer) => {
      this.ws.send(ClpPacket.serialize({
        type: Clp.TYPE_PREPARE,
        requestId: uuid(),
        data: {
          from: transfer.from,
          expiresAt: new Date(transfer.expiresAt),
          amount: parseInt(transfer.amount),
          executionCondition: Buffer.from(transfer.executionCondition, 'base64'),
          protocolData: MakeProtocolData(transfer)
        }
      }))
    })
    this.plugin.registerRequestHandler((request) => { 
      const promise = new Promise((resolve, reject) => {
        this.requestsReceived[request.id] = { resolve, reject }
      })
      this.ws.send(ClpPacket.serialize({
        type: Clp.TYPE_MESSAGE,
        requestId: request.id,
        data: MakeProtocolData(request)
      }))
      return promise
    })
    this.plugin.on('outgoing_fulfill', (transfer, fulfillment) => {
      this.ws.send(ClpPacket.serialize({
        type: Clp.TYPE_FULFILL,
        requestId: uuid(),
        data: {
          transferId: transfer.id,
          fulfillment: Buffer.from(fulfillment, 'base64') 
        }
      }))
    })
    this.plugin.on('outgoing_reject', (transfer, rejectionReason) => {
      this.ws.send(ClpPacket.serialize({
        type: Clp.TYPE_REJECT,
        requestId: uuid(),
        data: {
          transferId: transfer.id,
          rejectionReason
        }
      }))
      this.clp.sendCall(Clp.TYPE_REJECT, {
        transferId: transfer.id,
      })
    })
  },

  registerWebSocketMessageHandler() {
    this.ws.on('message', (buf) => {
      const obj = ClpPacket.deserialize(buf)
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
          this.requestsReceived[obj.requestId].resolve()
          delete this.requestsSent[obj.requestId]
          break
        case ClpPacket.TYPE_RESPONSE:
          if (Array.isArray(obj.data) && obj.data.length) {
            this.requestsReceived[obj.requestId].resolve(obj.data[0])
          } else { // treat it as an ACK, see https://github.com/interledger/rfcs/issues/283
            this.requestsReceived[obj.requestId].resolve()
          }
          delete this.requestsSent[obj.requestId]
          break

        case ClpPacket.TYPE_ERROR:
          // according to LPI, an error response should fulfill (not reject) the request handler promise
          this.requestsReceived[obj.requestId].fulfill(obj.data.rejectionReason)
          delete this.requestsSent[obj.requestId]
          break

        case ClpPacket.TYPE_PREPARE:
          this.plugin.sendTransfer({
            id: obj.data.transferId.toString(),
            from: this.plugin.getAccount(),
            to: protocolDataAsObj.to.data,
            ledger: this.plugin.getInfo().prefix,
            amount: obj.data.amount.toString(),
            ilp: protocolDataAsObj.ilp.data.toString('base64'),
            noteToSelf: {},
            executionCondition: transfer.executionCondition.toString('base64'),
            expiresAt: transfer.expiresAt.toISOString(),
            custom: {}
          })
          break

        case ClpPacket.TYPE_FULFILL:
          this.plugin.fulfillCondition(obj.data.transferId, obj.data.fulfillment.toString('base64'))
          break

        case ClpPacket.TYPE_REJECT:
          this.plugin.rejectIncomingTransfer(obj.data.transferId, IlpPacket.deserializeIlpError(obj.data.rejectionReason))
          break

        case ClpPacket.TYPE_MESSAGE:
          switch (obj.data[0].protocolName) {
            case 'ilp':
              const lpiRequest = {
                id: obj.requestId.toString(),
                from: this.plugin.getAccount(),
                to: protocolDataAsObj.to.data.toString('ascii'),
                ledger: this.plugin.getInfo().prefix,
                ilp: protocolDataAsObj.ilp.data.toString('base64'),
                custom: {}
              }
              this.plugin.sendRequest(lpiRequest).then((response) => {
                const responsePacketBuf = Buffer.from(response.ilp, 'base64')
                const ilpResponse = IlpPacket.deserializeIlpPacket(responsePacketBuf)
                const responseProtocolData = MakeProtocolData(response)
                if (ilpResponse.type ===  IlpPacket.TYPE_ILP_ERROR) {
                  this.ws.send(ClpPacket.serialize({
                    type: ClpPacket.TYPE_ERROR,
                    requestId: obj.requestId,
                    data: {
                      rejectionReason: err,
                      protocolData: responseProtocolData
                    }
                  }))
                } else {
                  this.ws.send(ClpPacket.serialize({
                    type: ClpPacket.TYPE_RESPONSE,
                    requestId: obj.requestId,
                    data: MakeProtocolData(response)
                  }))
                }
              }, err => {
                this.ws.send(ClpPacket.serialize({
                  type: ClpPacket.TYPE_ERROR,
                  requestId: obj.requestId,
                  data: {
                    rejectionReason: err,
                    protocolData: []
                  }
                }))
              })
              break
            case 'info':
              if (obj.data[0].data[0] === 0) {
                this.ws.send(ClpPacket.serialize({
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
                this.ws.send(ClpPacket.serialize({
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
              break
            case 'balance':
              this.plugin.getBalance().then(decStr => {
                let hexStr = parseInt(decStr).toString(16)
                if (hexStr.length % 2 === 1) {
                  hexStr = '0' + hexStr
                }
                let balanceBuf = Buffer.from(hexStr, 'hex')
                while (balanceBuf.length < 8) {
                  balanceBuf = Buffer.concat([ Buffer.from([ 0 ]), balanceBuf ])
                }
                this.ws.send(ClpPacket.serialize({
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
              break
          }
          break
        default:
         // ignore
      }
    })
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
