const http = require('http');
http.Server.prototype.listen = function () { console.log('listen intercepted'); return this; };
require('D:/mind-map/integrations/knowledge-mcp/src/server.js');
console.log('server load ok');
