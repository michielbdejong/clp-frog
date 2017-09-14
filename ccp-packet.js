module.exports = {
  TYPE_ROUTES: 0,
  TYPE_REQUEST_FULL_TABLE: 1,

  serialize (obj) {
    if (obj.type === 0) {
      const dataBuf = JSON.stringify(obj.data)
      return Buffer.concat([
        Buffer.from([0]),
        lengthPrefixFor(dataBuf),
        dataBuf
      ])
    } else if (obj.type === 1) {
      return Buffer.from([1])
    }
    throw new Error('unknown packet type')
  },

  deserialize (dataBuf) {
    let obj = {
      type: dataBuf[0]
    }
    if (dataBuf[0] === this.TYPE_ROUTE) {
      let lenLen = 1
      if (dataBuf[1] >= 128) {
        // See section 8.6.5 of http://www.itu.int/rec/T-REC-X.696-201508-I
        lenLen = 1 + (dataBuf[1] - 128)
      }
      try {
        obj.data = JSON.parse(dataBuf.slice(lenLen + 1).toString('ascii'))
      } catch (e) {
      }
    }
    return obj
  }
}
