#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';

if (process.argv[2] !== 'register' || process.argv.length !== 4) {
  console.error('Usage: deploy-admin register <ed25519-public-key>');
  process.exit(2);
}
const body = JSON.stringify({ key: process.argv[3] });
const result = await new Promise((resolve, reject) => {
  const req = http.request({ socketPath: '/run/app-services/admin.sock', path: '/register', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
    let text = '';
    res.setEncoding('utf8'); res.on('data', c => { text += c; });
    res.on('end', () => {
      if (res.statusCode !== 200) { reject(new Error(text)); return; }
      try { resolve(JSON.parse(text)); } catch (err) { reject(err); }
    });
  });
  req.on('error', reject); req.end(body);
});
const hostKey = (await fs.readFile('/srv/app-services/ssh/ssh_host_ed25519_key.pub', 'utf8')).trim().split(' ').slice(0, 2).join(' ');
console.log(JSON.stringify({ ...result, hostKey }));
