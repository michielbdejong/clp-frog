# clp-frog

[![Greenkeeper badge](https://badges.greenkeeper.io/michielbdejong/clp-frog.svg)](https://greenkeeper.io/)

Tiny wrapper around Interledger's Ledger Plugin Interface, that exposes the plugin's interface over CLP
It uses `protocolName: 'from'` and `protocolName: 'to'`, both with `contentType: textPlainUtf8(1)`, to convey the 'from' and 'to' address of LPI's `incoming_prepare` and `incoming_request` events
in CLP's `PREPARE` and `MESSAGE` calls.

You can do the same to convey the 'to' field of LPI's `sendTransfer` and `sendRequest` calls in CLP's `PREPARE` and `MESSAGE` calls.
You may also specify the 'from' field in the 'from' protocol data, but if you leave it out, `plugin.getAccount()` will be used.

The ['balance' protocol](https://github.com/interledger/interledger/wiki/Interledger-over-CLP#balance) and ['info' protocol](https://github.com/interledger/interledger/wiki/Interledger-over-CLP#info) (packets 3 and 4) can be used to access `plugin.getBalance` and `plugin.getInfo`.

![frog](http://kids.nationalgeographic.com/content/dam/kids/photos/articles/Other%20Explore%20Photos/R-Z/Wacky%20Weekend/Frogs/ww-frogs-waxy-monkey-tree.adapt.945.1.jpg "Common Frog")

To see a usage example, it's easiest to put your [clp-frog together with a clp-cat](https://github.com/michielbdejong/clp-cat).
