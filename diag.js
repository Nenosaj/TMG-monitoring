// Quick diagnostic — logs raw ntopng host response to see actual field names
require('dotenv').config();
const { makeClient } = require('./server/ntopngClient');
const client = makeClient({
  baseUrl: process.env.NTOPNG_URL,
  user:    process.env.NTOPNG_USER,
  pass:    process.env.NTOPNG_PASS,
  ifid:    process.env.NTOPNG_IFID || '0',
});

(async () => {
  const hosts = await client.getActiveHosts();
  const h = hosts.find(h => (h.ip || '').startsWith('192.168.70.')) || hosts[0];
  if (!h) { console.log('No hosts found'); return; }
  console.log('\n=== RAW HOST OBJECT keys ===');
  Object.keys(h).forEach(k => { if (k.toLowerCase().includes('byte') || k.toLowerCase().includes('sent') || k.toLowerCase().includes('rcvd') || k === 'thpt' || k === 'bps') console.log(`  ${k}:`, h[k]); });
  console.log('\n=== h.bytes ===', h.bytes);
  console.log('=== h["bytes.sent"] ===', h["bytes.sent"]);
  console.log('=== h["bytes.rcvd"] ===', h["bytes.rcvd"]);

  const l7 = await client.getHostL7Stats(h.ip);
  console.log('\n=== RAW L7 first entry ===', l7[0]);
  console.log('=== L7 keys ===', l7[0] ? Object.keys(l7[0]) : 'empty');

  const details = await client.getHostDetails(h.ip);
  if (details) {
    console.log('\n=== HOST DETAILS bytes fields ===');
    Object.keys(details).filter(k => k.toLowerCase().includes('byte') || k.toLowerCase().includes('sent') || k.toLowerCase().includes('rcvd')).forEach(k => console.log(`  ${k}:`, details[k]));
  }
})().catch(e => console.error(e.message));
