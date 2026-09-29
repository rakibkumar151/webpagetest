const Turn = require('node-turn');
const server = new Turn({
  authMech: 'long-term',
  credentials: {
    testuser: "testpass"
  },
  listeningPort: 3478,
  listeningIps: ['127.0.0.1'],
  relayIps: ['127.0.0.1'], 
});
server.start();
console.log('TURN server running on port 3478 with testuser/testpass');
