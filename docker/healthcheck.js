import net from 'node:net';
const s = net.connect(6380, '127.0.0.1');
s.setTimeout(1500, () => process.exit(1));
s.on('error', () => process.exit(1));
s.on('connect', () => s.write('PING\r\n'));
s.on('data', (d) => process.exit(/^(\+PONG|-NOAUTH)/.test(d.toString()) ? 0 : 1));
