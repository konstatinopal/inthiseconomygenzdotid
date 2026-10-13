import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { loadConfig } from './config';
import { createApp } from './app';

const config = await loadConfig();
const { app } = createApp(config);
const server = config.https
  ? https.createServer({ key: fs.readFileSync(config.https.key), cert: fs.readFileSync(config.https.cert) }, app)
  : http.createServer(app);

server.listen(config.port, config.hostname, () => {
  console.log(`inthiseconomygenz.id sync server listening on ${config.https ? 'https' : 'http'}://${config.hostname}:${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
});
