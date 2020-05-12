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
/** Abstract interfaces and serialization to keep different
 * versions compatible to each other.
 *
 * Watch out before changing anything in this file. Content is reused
 * between webclient, signaling server and needs to remain compatible to
 * the C# implementation.
 */
export const NetEventType = {
    0: 'Invalid', Invalid: 0,
    1: 'UnreliableMessageReceived', UnreliableMessageReceived: 1,
    2: 'ReliableMessageReceived', ReliableMessageReceived: 2,
    3: 'ServerInitialized', ServerInitialized: 3,
    4: 'ServerInitFailed', ServerInitFailed: 4,
    5: 'ServerClosed', ServerClosed: 5,
    6: 'NewConnection', NewConnection: 6,
    7: 'ConnectionFailed', ConnectionFailed: 7,
    8: 'Disconnected', Disconnected: 8,
    100: 'FatalError', FatalError: 100,
    101: 'Warning', Warning: 101,
    102: 'Log', Log: 102,

    /// <summary>
    /// This value and higher are reserved for other uses. 
    /// Should never get to the user and should be filtered out.
    /// </summary>
    200: 'ReservedStart', ReservedStart: 200,

    /// <summary>
    /// Reserved.
    /// Used by protocols that forward NetworkEvents
    /// </summary>
    201: 'MetaVersion', MetaVersion: 201,

    /// <summary>
    /// Reserved.
    /// Used by protocols that forward NetworkEvents.
    /// </summary>
    202: 'MetaHeartbeat', MetaHeartbeat: 202
};

export const NetEventDataType = {
    0: 'Null', Null: 0,
    1: 'ByteArray', ByteArray: 1,
    2: 'UTF16String', UTF16String: 2
};

export class NetworkEvent {
    constructor(t, conId, data) {
        this.type = t;
        this.connectionId = conId;
        this.data = data;
    }

    get RawData() {
        return this.data;
    }

    get MessageData() {
        if (typeof this.data !== 'string')
            return this.data;
        return null;
    }

    get Info() {
        if (typeof this.data === "string")
            return this.data;
        return null;
    }

    get Type() {
        return this.type;
    }

    get ConnectionId() {
        return this.connectionId;
    }

    toString() {
        const data = typeof this.data === 'string' ? this.data : '';
        return `NetworkEvent[NetEventType: (${NetEventType[this.type]}), id: (${this.connectionId.id}), Data: (${data})]`;
    }

    static parseFromString(str) {
        const values = JSON.parse(str);
        let data;
        if (!values.data) {
            data = null;
        } else if (typeof values.data === 'string') {
            data = values.data;
        } else if (typeof values.data === 'object') {
            //json represents the array as an object containing each index and the
            //value as string number ... improve that later
            const arrayAsObject = values.data;
            let length = 0;
            for (let prop in arrayAsObject) {
                //if (arrayAsObject.hasOwnProperty(prop)) { //shouldnt be needed
                length++;
                //}
            }
            const buffer = new Uint8Array(Object.keys(arrayAsObject).length);
            for (let i = 0; i < buffer.length; i++)
                buffer[i] = arrayAsObject[i];
            data = buffer;
        } else {
            console.log(`network event can't be parsed: ${str}`);
        }
        const evt = new NetworkEvent(values.type, values.connectionId, data);
        return evt;
    }

    static toString(evt) {
        return JSON.stringify(evt);
    }

    static fromByteArray(arrin) {
        //old node js versions seem to not return proper Uint8Arrays but
        //buffers -> make sure it is a Uint8Array
        const arr = new Uint8Array(arrin);
        const type = arr[0]; //byte
        const dataType = arr[1]; //byte
        const id = new Int16Array(arr.buffer, arr.byteOffset + 2, 1)[0]; //short
        let data = null;
        if (dataType === NetEventDataType.ByteArray) {
            const length = new Uint32Array(arr.buffer, arr.byteOffset + 4, 1)[0]; //uint
            const byteArray = new Uint8Array(arr.buffer, arr.byteOffset + 8, length);
            data = byteArray;
        } else if (dataType === NetEventDataType.UTF16String) {
            const length = new Uint32Array(arr.buffer, arr.byteOffset + 4, 1)[0]; //uint
            const uint16Arr = new Uint16Array(arr.buffer, arr.byteOffset + 8, length);
            let str = [...uint16Arr].map(x => String.fromCharCode(x)).join('');
            data = str;
        } else if (dataType == NetEventDataType.Null) {
            //message has no data
        } else {
            throw new Error(`Message has an invalid data type flag: ${dataType}`);
        }
        const conId = new ConnectionId(id);
        const result = new NetworkEvent(type, conId, data);
        return result;
    }

    static toByteArray(evt) {
        let dataType;
        let length = 4; //4 bytes are always needed

        //getting type and length
        if (!evt.data) {
            dataType = NetEventDataType.Null;
        } else if (typeof evt.data === 'string') {
            dataType = NetEventDataType.UTF16String;
            length += evt.data.length * 2 + 4;
        } else {
            dataType = NetEventDataType.ByteArray;
            length += 4 + evt.data.length;
        }

        //creating the byte array
        const result = new Uint8Array(length);
        result[0] = evt.type;
        result[1] = dataType;
        const conIdField = new Int16Array(result.buffer, result.byteOffset + 2, 1);
        conIdField[0] = evt.connectionId.id;
        if (dataType === NetEventDataType.ByteArray) {
            const byteArray = evt.data;
            const lengthField = new Uint32Array(result.buffer, result.byteOffset + 4, 1);
            lengthField[0] = byteArray.length;
            for (let i = 0; i < byteArray.length; i++) {
                result[8 + i] = byteArray[i];
            }
        } else if (dataType == NetEventDataType.UTF16String) {
            const str = evt.data;
            const lengthField = new Uint32Array(result.buffer, result.byteOffset + 4, 1);
            lengthField[0] = str.length;
            const dataField = new Uint16Array(result.buffer, result.byteOffset + 8, str.length);
            for (let i = 0; i < dataField.length; i++) {
                dataField[i] = str.charCodeAt(i);
            }
        }

        return result;
    }
}

export class ConnectionId{
    constructor(nid) {
        this.id = nid;
    }
    static INVALID = new ConnectionId(-1);
}

//export {NetEventType, NetworkEvent, ConnectionId, INetwork, IBasicNetwork};
//# sourceMappingURL=INetwork.js.map
