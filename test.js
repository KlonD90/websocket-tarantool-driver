var TarantoolConnection = require('./lib/connection.js')

var tnt = new TarantoolConnection('ws://localhost:8080/');
const f = async () => {
  const res = await tnt.select('test', 'primary', 1, 0, 'eq', [1])
  console.log(res);
  const res1 = await tnt.insert('test', [1, 2, 'sss'])
  console.log(res1);
  const res2 = await tnt.select('test', 'primary', 1, 0, 'eq', [1])
  console.log(res2);
}

f();

require('./test/app')