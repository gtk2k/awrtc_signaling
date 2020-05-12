import Koa from 'koa';
import Router from 'koa-router';
import websockify from 'koa-websocket';
import serve from 'koa-static';
import http from 'http';
import https from 'https';
import fs from 'fs';
import { dirname } from 'path';
import url, { fileURLToPath } from 'url';
import { Endpoint, PeerPool, WebsocketNetworkServer } from './esWebSocketNetworkServer.mjs';

const buf = fs.readFileSync('./config.json');
const config = JSON.parse(buf.toString());
const __dirname = dirname(fileURLToPath(import.meta.url));
//const router = new Router();
const wsRouter = new Router();

const env_port = process.env.port || process.env.PORT;
if (env_port) {
    console.log(`The environment variable process.env.port or PORT is set to ${env_port}. Ports set in config json will be ignored`);
    //overwrite config ports to use whatever the cloud wants us to
    if (config.httpConfig)
        config.httpConfig.port = env_port;
    if (config.httpsConfig)
        config.httpsConfig.port = env_port;
    if (config.httpConfig && config.httpsConfig) {
        //Many cloud provider set process.env.port and don't allow multiple ports 
        //If this is the case https will be deactivated to avoid a crash due to two services 
        //trying to use the same port
        //heroku will actually reroute HTTPS port 443 to regular HTTP on 80 so one port with HTTP is enough
        console.warn("Only http/ws will be started as only one port can be set via process.env.port.");
        console.warn("Remove the httpConfig section in the config.json if you want to use https"
            + " instead or make sure the PORT variable is not set by you / your provider.");
        delete config.httpsConfig;
    }
}

let app = null;
if (config.httpConfig) {
    app = websockify(new Koa(), {
        maxPayload: config.maxPayload
    });
}
if (config.httpsConfig) {
    app = websockify(new Koa(), {
        maxPayload: config.maxPayload
    }, {
        key: fs.readFileSync(config.httpsConfig.ssl_key_file),
        cert: fs.readFileSync(config.httpsConfig.ssl_cert_file)
    });
}

const pool = {};
config.apps.forEach(app => {
    if (!(app.path in pool)) {
        console.log(`Add new pool ${app.path}`);
        pool[app.path] = new PeerPool(app);
    }
    wsRouter.all(app.path, async ctx => {
        const ep = new Endpoint();
        ep.ws = ctx.websocket;
        ep.remoteAddress = ctx.request.socket.remoteAddress;
        ep.remotePort = ctx.request.socket.remotePort;
        ep.localAddress = ctx.request.socket.localAddress;
        ep.localPort = ctx.request.socket.localPort;
        let p = null;
        try {
            p = url.parse(ctx.request.url);
        } catch (ex) {
            console.error(ex);
        }
        ep.appPath = url.parse(ctx.request.url).path;
        if (ep.appPath in pool) {
            if (WebsocketNetworkServer.sVerboseLog) {
                console.log(`New websocket connection: ${ep.getConnectionInfo()}`);
                pool[ep.appPath].add(ep);
            } else {
                console.error(`Websocket tried to connect to unknown app  ${ep.appPath}`);
                ctx.websockt.close();
            }
        }
    });
});

//request handler that will deliver files from public directory
//can be used like a simple http / https webserver
app.use(serve(__dirname + '/public'));
app.ws.use(wsRouter.routes()).use(wsRouter.allowedMethods());

if (config.httpConfig)
    app.listen(config.httpConfig.port, _ => {
        console.log(`listen ${config.httpConfig.port}`);
    });
else if (config.httpsConfig)
    app.listen(config.httpsConfig.port, _ => {
        console.log(`listen ${config.httpsConfig.port}`);
    });

