const Frog = require('./index')
const Plugin = require('ilp-plugin-bells')

const plugin = new Plugin({
  account: 'https://red.ilpdemo.org/ledger/accounts/alice',
  password: 'alice'
})

const frog = new Frog({
    clp:  {
      // Run as a CLP server:
      listen:8000

      // Or as a CLP client:
      // name: 'alice',
      // upstreams: [
      //   {
      //     url: 'ws://localhost:8000/frog/clp/v1',
      //     token: 'alice'
      //   }
      // ]
    },
    plugin
})

frog.start().then(() => {
  console.log('started')
})
