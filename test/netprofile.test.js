// Unit tests for parsing `pcos-network status` (RudramOS). Run with: node test/netprofile.test.js
const assert = require('assert');
const path = require('path');
const { parseRudramOSStatus } = require(path.join(__dirname, '..', 'dist', 'main', 'netprofile.js'));

const status = (networks, sharing) =>
  ['Networks now:', ...networks.map((n) => `  ${n}`), 'Sharing on Home networks:', ...sharing.map((s) => `  ${s}`)].join('\n');

const cases = [
  ['only a Public network', status(['Cafe: Free WiFi (wlp2s0): Public'], ['nothing shared']),
    { os: 'rudramos', kind: 'public', networks: ['Cafe: Free WiFi'] }],
  ['Home network, LAN Share not allowed', status(['Home (wlp2s0): Home (trusted)'], ['phone: on']),
    { os: 'rudramos', kind: 'sharing-off', networks: ['Home'] }],
  ['Home network, LAN Share allowed', status(['Home (wlp2s0): Home (trusted)'], ['phone: on', 'lan-share: on']), null],
  ['Home wired + Public Wi-Fi, allowed', status(['Wired connection 1 (enp3s0): Home (trusted)', 'Cafe (wlp2s0): Public'], ['lan-share: on']), null],
  ['no networks', status(['none'], ['nothing shared']), null],
  ['network name with brackets', status(['My (Office) Net (enp3s0): Public'], ['nothing shared']),
    { os: 'rudramos', kind: 'public', networks: ['My (Office) Net'] }],
  ['lan-share off is not on', status(['Home (wlp2s0): Home (trusted)'], ['lan-share-old: on']),
    { os: 'rudramos', kind: 'sharing-off', networks: ['Home'] }],
];

let failed = 0;
for (const [name, input, expected] of cases) {
  try {
    assert.deepStrictEqual(parseRudramOSStatus(input), expected);
    console.log(`ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n${err.message}`);
  }
}
if (failed) process.exit(1);
console.log('All netprofile tests passed');
