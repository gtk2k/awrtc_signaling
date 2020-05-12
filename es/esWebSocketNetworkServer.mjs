/*
Copyright (c) 2019, because-why-not.com Limited
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import WebSocket from 'ws';
import url from 'url';
import * as inet from './esINetwork.mjs';

/**
 * Gathers all data related to a single websocket.
 *
 */
export class Endpoint {
    constructor() {

    }

    getConnectionInfo() {
        return `${this.remoteAddress}:${this.remotePort} ${this.appPath}`;
    }

    getLocalConnectionInfo() {
        if (this.localAddress && this.localPort)
            return `${this.localAddress}:${this.localPort}`;
        return 'unknown';
    }
}

export class WebsocketNetworkServer {
    constructor() {
        this.mpool = {};
    }

    static sVerboseLog = true;

    static SetLogLevel(verbose) {
        WebsocketNetworkServer.sVerboseLog = verbose;
    }

    static logv(msg) {
        if (WebsocketNetworkServer.sVerboseLog) {
            console.log(`(${new Date().toISOString()})${msg}`);
        }
    }

    onConnection(ep) {
        this.mpool[ep.appPath].add(ep);
    }

    /**Adds a new websocket server that will be used to receive incoming connections for
     * the given apps.
     *
     * @param websocketServer server used for the incoming connections
     * @param appConfig app the incoming connections are allowed to connect to
     * Apps can be given multiple times with different signaling servers to support different
     * ports and protocols.
     */
    addSocketServer(websocketServer, appConfigs) {
        for (let i = 0; i < appConfigs.length; i++) {
            const app = appConfigs[i];
            if (!(app.path in this.pool)) {
                console.log(`Add new pool ${app.path}`);
                this.mPool[app.path] = new PeerPool(app);
            }
        }

        websocketServer.on('connection', (socket, request) => {
            const ep = new Endpoint();
            ep.ws = socket;
            ep.remoteAddress = request.socket.remoteAddress;
            ep.remotePort = request.socket.remotePort;
            ep.localAddress = request.socket.localAddress;
            ep.localPort = request.socket.localPort;
            ep.appPath = url.parse(request.url).pathname;
            if (ep.appPath in this.mPool) {
                if (WebsocketNetworkServer.sVerboseLog)
                    console.log(`New websocket connection: ${ep.getConnectionInfo()}`);
                this.onConnection(ep);
            } else {
                console.error(`Websocket tried to connect to unknown app  ${ep.appPath}`);
                socket.close();
            }
        });
    }
}

//Pool of client connects that are allowed to communicate to each other
export class PeerPool {
    constructor(config) {
        this.mConnections = [];
        this.mServers = {};
        this.mAddressSharing = false;
        this.maxAddressLength = 256;
        this.mAppConfig = config;
        if (this.mAppConfig.address_sharing) {
            this.mAddressSharing = this.mAppConfig.address_sharing;
        }
    }

    hasAddressSharing() {
        return this.mAddressSharing;
    }

    //add a new connection based on this websocket
    add(ep) {
        const peer = new SignalingPeer(this, ep);
        this.mConnections.push(peer);
    }

    //Returns the SignalingClientConnection that opened a server using the given address
    //or null if address not in use
    getServerConnection(address) {
        return this.mServers[address];
    }

    //Tests if the address is available for use. 
    //returns true in the following cases
    //the address is longer than the maxAddressLength and the server the address is not yet in use or address sharing is active
    isAddressAvailable(address) {
        if (address.length <= this.maxAddressLength // only allow addresses shorter than maxAddressLength
            && (!this.mServers[address] || this.mAddressSharing)) {
            return true;
        }
        return false;
    }

    //Adds the server. No checking is performed here! logic should be solely in the connection class
    addServer(client, address) {
        this.mServers[address] = this.mServers[address] || [];
        this.mServers[address].push(client);
    }

    //Removes an address from the server. No checks performed
    removeServer(client, address) {
        //supports address sharing. remove the client from the server list that share the address
        if (!this.mServers[address].includes(client)) {
            this.mServers[address].splice(index, 1);
        }
        //delete the whole list if the last one left
        if (this.mServers[address].length === 0) {
            delete this.mServers[address];
            WebsocketNetworkServer.logv(`Address ${address} released.`);
        }
    }

    //Removes a given connection from the pool
    removeConnection(client) {
        if (!this.mConnections.includes(client)) {
            this.mConnections.splice(index, 1);
        } else {
            console.warn(`Tried to remove unknown SignalingClientConnection. Bug?${client.GetLogPrefix()}`);
        }
    }

    count() {
        return this.mConnections.length;
    }
}

const SignalingConnectionState = {
    0: 'Uninitialized', Uninitialized: 0,
    1: 'Connecting', Connecting: 1,
    2: 'Connected', Connected: 2,
    3: 'Disconnecting', Disconnecting: 3,
    4: 'Disconnected', Disconnected: 4
};

///note: all methods starting with "internal" might leave the system in an inconsistent state
///e.g. peerA is connected to peerB means peerB is connected to peerA but internalRemoveConnection
///could cause peerA being disconnected from peerB but peerB still thinking to be connected to peerA!!!
class SignalingPeer {
    constructor(pool, ep) {
        this.mState = SignalingConnectionState.Uninitialized;
        this.mConnections = {};
        //C# version uses short so 16384 is 50% of the positive numbers (maybe might make sense to change to ushort or int)
        this.mNextIncomingConnectionId = new inet.ConnectionId(16384);
        /// <summary>
        /// Assume 1 until message received
        /// </summary>
        this.mRemoteProtocolVersion = 1;
        this.mConnectionPool = pool;
        this.mEndPoint = ep;
        this.mPongReceived = true;
        this.mState = SignalingConnectionState.Connecting;
        WebsocketNetworkServer.logv(`[${this.mEndPoint.getConnectionInfo()}] connected on ${this.mEndPoint.getLocalConnectionInfo()}`);
        this.mEndPoint.ws.on('message', (message, flags) => {
            this.onMessage(message, flags);
        });
        this.mEndPoint.ws.on('error', (error) => {
            console.error(error);
        });

        this.mEndPoint.ws.on('close', (code, message) => {
            this.onClose(code, message);
        });
        this.mEndPoint.ws.on('pong', (data, flags) => {
            this.mPongReceived = true;
            this.logInc('pong');
        });
        this.mState = SignalingConnectionState.Connected;
        this.mPingInterval = setInterval(this.doPing, 30000);
    }

    GetLogPrefix() {
        //used to identify this peer for log messages / debugging
        return `[${this.mEndPoint.getConnectionInfo()}]`;
    }

    doPing() {
        if (this.mState === SignalingConnectionState.Connected
            && this.mEndPoint.ws.readyState === WebSocket.OPEN) {
            if (!this.mPongReceived) {
                this.NoPongTimeout();
                return;
            }
            this.mPongReceived = false;
            this.mEndPoint.ws.ping();
            this.logOut('ping');
        }
    }

    evtToString(evt) {
        let data = null;
        if (evt.Info !== null) {
            data = evt.Info;
        } else if(evt.MessageData) {
            // TODO
            const chars = new Uint16Array(evt.MessageData.buffer, evt.MessageData.byteOffset, evt.MessageData.byteLength / 2);
            data = [...chars].map(x => String.fromCharCode(x)).join('');
        }
        const output = `[NetEventType: (${inet.NetEventType[evt.Type]}), id: (${evt.ConnectionId.id}), Data: (${data})]`;
        return output;
    }

    onMessage(inmessage, flags) {
        try {
            this.parseMessage(inmessage);
        } catch (err) {
            WebsocketNetworkServer.logv(`${this.GetLogPrefix()} Invalid message received: ${inmessage}\n Error: ${err}`);
        }
    }

    sendToClient(evt) {
        //this method is also called during cleanup after a disconnect
        //check first if we are still connected
        //bugfix: apprently 2 sockets can be closed at exactly the same time without
        //onclosed being called immediately -> socket has to be checked if open
        if (this.mState === SignalingConnectionState.Connected
            && this.mEndPoint.ws.readyState === WebSocket.OPEN) {
            this.logOut(this.evtToString(evt));
            var msg = inet.NetworkEvent.toByteArray(evt);
            this.internalSend(msg);
        }
    }

    logOut(msg) {
        WebsocketNetworkServer.logv(`${this.GetLogPrefix()}OUT: ${msg}`);
    }

    logInc(msg) {
        WebsocketNetworkServer.logv(`${this.GetLogPrefix()}INC: ${msg}`);
    }

    sendVersion() {
        const msg = new Uint8Array(2);
        const ver = SignalingPeer.PROTOCOL_VERSION;
        msg[0] = inet.NetEventType.MetaVersion;
        msg[1] = ver;
        this.logOut(`version ${ver}`);
        this.internalSend(msg);
    }

    sendHeartbeat() {
        const msg = new Uint8Array(1);
        msg[0] = inet.NetEventType.MetaHeartbeat;
        this.logOut('heartbeat');
        this.internalSend(msg);
    }

    internalSend(msg) {
        this.mEndPoint.ws.send(msg);
    }

    onClose(code, error) {
        WebsocketNetworkServer.logv(`${this.GetLogPrefix()} CLOSED!`);
        this.Cleanup();
    }

    NoPongTimeout() {
        WebsocketNetworkServer.logv(`${this.GetLogPrefix()} TIMEOUT!`);
        this.Cleanup();
    }

    //used for onClose or NoPongTimeout
    Cleanup() {
        //if the connection was cleaned up during a timeout it might get triggered again during closing.
        if (this.mState === SignalingConnectionState.Disconnecting
            || this.mState === SignalingConnectionState.Disconnected)
            return;
        this.mState = SignalingConnectionState.Disconnecting;
        WebsocketNetworkServer.logv(`${this.GetLogPrefix()} disconnecting.`);
        if (this.mPingInterval) {
            clearInterval(this.mPingInterval);
        }
        this.mConnectionPool.removeConnection(this);
        //disconnect all connections
        const test = this.mConnections; //workaround for not having a proper dictionary yet...
        for (let v in this.mConnections) {
            if (this.mConnections.hasOwnProperty(v))
                this.disconnect(new inet.ConnectionId(+v));
        }
        //make sure the server address is freed 
        if (this.mServerAddress) {
            this.stopServer();
        }
        this.mEndPoint.ws.terminate();
        WebsocketNetworkServer.logv(`${this.GetLogPrefix()}removed ${this.mConnectionPool.count()} connections left in pool`);
        this.mState = SignalingConnectionState.Disconnected;
    }

    parseMessage(msg) {
        if (msg[0] === inet.NetEventType.MetaVersion) {
            const v = msg[1];
            this.logInc(`protocol version ${v}`);
            this.mRemoteProtocolVersion = v;
            this.sendVersion();
        } else if (msg[0] === inet.NetEventType.MetaHeartbeat) {
            this.logInc('heartbeat');
            this.sendHeartbeat();
        } else {
            const evt = inet.NetworkEvent.fromByteArray(msg);
            this.logInc(this.evtToString(evt));
            this.handleIncomingEvent(evt);
        }
    }

    handleIncomingEvent(evt) {
        console.log(evt.Type);
        //update internal state based on the event
        if (evt.Type === inet.NetEventType.NewConnection) {
            //client wants to connect to another client
            const address = evt.Info;
            //the id this connection should be addressed with
            const newConnectionId = evt.ConnectionId;
            this.connect(address, newConnectionId);
        } else if (evt.Type === inet.NetEventType.ConnectionFailed) {
            //should never be received
        } else if (evt.Type === inet.NetEventType.Disconnected) {
            //peer tries to disconnect from another peer
            const otherPeerId = evt.ConnectionId;
            this.disconnect(otherPeerId);
        } else if (evt.Type === inet.NetEventType.ServerInitialized) {
            this.startServer(evt.Info);
        } else if (evt.Type === inet.NetEventType.ServerInitFailed) {
            //should never happen
        } else if (evt.Type === inet.NetEventType.ServerClosed) {
            //stop server request
            this.stopServer();
        } else if (evt.Type === inet.NetEventType.ReliableMessageReceived) {
            this.sendData(evt.ConnectionId, evt.MessageData, true);
        } else if (evt.Type === inet.NetEventType.UnreliableMessageReceived) {
            this.sendData(evt.ConnectionId, evt.MessageData, false);
        }
    }

    internalAddIncomingPeer(peer) {
        //another peer connected to this (while allowing incoming connections)
        //store the reference
        const id = this.nextConnectionId();
        this.mConnections[id.id] = peer;
        //event to this (the other peer gets the event via addOutgoing
        this.sendToClient(new inet.NetworkEvent(inet.NetEventType.NewConnection, id, null));
    }

    internalAddOutgoingPeer(peer, id) {
        //this peer successfully connected to another peer. id was generated on the 
        //client side
        this.mConnections[id.id] = peer;
        //event to this (the other peer gets the event via addOutgoing
        this.sendToClient(new inet.NetworkEvent(inet.NetEventType.NewConnection, id, null));
    }

    internalRemovePeer(id) {
        delete this.mConnections[id.id];
        this.sendToClient(new inet.NetworkEvent(inet.NetEventType.Disconnected, id, null));
    }

    //test this. might cause problems
    //the number is converted to string trough java script but we need get back the number
    //for creating the connection id
    findPeerConnectionId(otherPeer) {
        for (let peer in this.mConnections) {
            if (this.mConnections[peer] === otherPeer) {
                return new inet.ConnectionId(+peer);
            }
        }
    }

    nextConnectionId() {
        var result = this.mNextIncomingConnectionId;
        this.mNextIncomingConnectionId = new inet.ConnectionId(this.mNextIncomingConnectionId.id + 1);
        return result;
    }

    //public methods (not really needed but can be used for testing or server side deubgging)
    //this peer initializes a connection to a certain address. The connection id is set by the client
    //to allow tracking of the connection attempt
    connect(address, newConnectionId) {
        const serverConnections = this.mConnectionPool.getServerConnection(address);
        if (serverConnections && serverConnections.length === 1) {
            //inform the server connection about the new peer
            //events will be send by these methods
            //shared addresses -> connect to everyone listening
            serverConnections[0].internalAddIncomingPeer(this);
            this.internalAddOutgoingPeer(serverConnections[0], newConnectionId);
        } else {
            //if address is not in use or it is in multi join mode -> connection fails
            this.sendToClient(new inet.NetworkEvent(inet.NetEventType.ConnectionFailed, newConnectionId, null));
        }
    }

    //join connection happens if another user joins a multi address. it will connect to every address
    //listening to that room
    connectJoin(address) {
        const serverConnections = this.mConnectionPool.getServerConnection(address);
        //in join mode every connection is incoming as everyone listens together
        if (serverConnections) {
            for (let i = 0; i < serverConnections.length; i++) {
                var v = serverConnections[i];
                if (v !== this) { //avoid connecting the peer to itself
                    v.internalAddIncomingPeer(this);
                    this.internalAddIncomingPeer(v);
                }
            }
        }
    }

    disconnect(connectionId) {
        const otherPeer = this.mConnections[connectionId.id];
        if (otherPeer) {
            const idOfOther = otherPeer.findPeerConnectionId(this);
            //find the connection id the other peer uses to talk to this one
            this.internalRemovePeer(connectionId);
            otherPeer.internalRemovePeer(idOfOther);
        } else {
            //the connectionid isn't connected 
            //invalid -> do nothing or log?
        }
    }

    startServer(address) {
        //what to do if it is already a server?
        if (this.mServerAddress)
            this.stopServer();
        if (this.mConnectionPool.isAddressAvailable(address)) {
            this.mServerAddress = address;
            this.mConnectionPool.addServer(this, address);
            this.sendToClient(new inet.NetworkEvent(inet.NetEventType.ServerInitialized, inet.ConnectionId.INVALID, address));
            if (this.mConnectionPool.hasAddressSharing()) {
                //address sharing is active. connect to every endpoint already listening on this address
                this.connectJoin(address);
            }
        } else {
            this.sendToClient(new inet.NetworkEvent(inet.NetEventType.ServerInitFailed, inet.ConnectionId.INVALID, address));
        }
    }

    stopServer() {
        if (this.mServerAddress) {
            this.mConnectionPool.removeServer(this, this.mServerAddress);
            this.sendToClient(new inet.NetworkEvent(inet.NetEventType.ServerClosed, inet.ConnectionId.INVALID, null));
            this.mServerAddress = null;
        }
        //do nothing if it wasnt a server
    }

    forwardMessage(senderPeer, msg, reliable) {
        const id = this.findPeerConnectionId(senderPeer);
        if (reliable)
            this.sendToClient(new inet.NetworkEvent(inet.NetEventType.ReliableMessageReceived, id, msg));
        else
            this.sendToClient(new inet.NetworkEvent(inet.NetEventType.UnreliableMessageReceived, id, msg));
    }

    sendData(id, msg, reliable) {
        const peer = this.mConnections[id.id];
        if (peer)
            peer.forwardMessage(this, msg, reliable);
    }

    /// <summary>
    /// Version of the protocol implemented here
    /// </summary>
    static PROTOCOL_VERSION = 2;

    /// <summary>
    /// Minimal protocol version that is still supported.
    /// V 1 servers won't understand heartbeat and version
    /// messages but would just log an unknown message and
    /// continue normally.
    /// </summary>
    static PROTOCOL_VERSION_MIN = 1;
}