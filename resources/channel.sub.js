(function() {
    function randInt(bits) {
        if (bits < 1 || bits > 53) {
            throw new TypeError();
        } else {
            if (bits >= 1 && bits <= 30) {
                return 0 | ((1 << bits) * Math.random());
            } else {
                var high = (0 | ((1 << (bits - 30)) * Math.random())) * (1 << 30);
                var low = 0 | ((1 << 30) * Math.random());
                return  high + low;
            }
        }
    }


    function toHex(x, length) {
        var rv = x.toString(16);
        while (rv.length < length) {
            rv = "0" + rv;
        }
        return rv;
    }

    function createUuid() {
        return [toHex(randInt(32), 8),
         toHex(randInt(16), 4),
         toHex(0x4000 | randInt(12), 4),
         toHex(0x8000 | randInt(14), 4),
         toHex(randInt(48), 12)].join("-");
    }


    // TODO: should be a way to clean up unused sockets
    class SocketCache {
        constructor() {
            this.readSockets = new Map();
            this.writeSockets = new Map();
        };

        async getOrCreate(type, uuid, onmessage=null) {
            function createSocket() {
                let protocol = self.isSecureContext ? "wss" : "ws";
                let port = self.isSecureContext? "{{ports[wss][0]}}" : "{{ports[ws][0]}}";
                let url = `${protocol}://{{host}}:${port}/msg_channel?uuid=${uuid}&direction=${type}`;
                console.log(uuid, `Creating socket ${type}`);
                let socket = new WebSocket(url);
                if (onmessage !== null) {
                    socket.onmessage = onmessage;
                };
                return new Promise(resolve => socket.addEventListener("open", () => resolve(socket)));
            }

            let socket;
            if (type === "read") {
                if (this.readSockets.has(uuid)) {
                    throw new Error("Can't create multiple read sockets with same UUID");
                }
                socket = await createSocket();
                this.readSockets.set(uuid, socket);
            } else if (type === "write") {
                let count;
                if (onmessage !== null) {
                    throw new Error("Can't set message handler for write sockets");
                }
                if (this.writeSockets.has(uuid)) {
                    [socket, count] = this.writeSockets.get(uuid);
                } else {
                    socket = await createSocket();
                    count = 0;
                }
                count += 1;
                this.writeSockets.set(uuid, [socket, count]);
            } else {
                throw new Error(`Unknown type ${type}`);
            }
            return socket;
        };

        async close(type, uuid) {
            let target = type === "read" ? this.readSockets : this.writeSockets;
            const data = target.get(uuid);
            if (!data) {
                return;
            }
            let count, socket;
            if (type == "read") {
                socket = data;
                count = 0;
            } else if (type === "write") {
                [socket, count] = data;
                count -= 1;
                if (count > 0) {
                    target.set(uuid, [socket, count]);
                }
            };
            if (count <= 0 && socket) {
                console.log(uuid, `Closing socket ${type} with no consumers`);
                target.delete(uuid);
                socket.close(1000);
                await new Promise(resolve => socket.onclose = () => {console.log(uuid, "Closed"); resolve();});
            }
        };

        async closeAll() {
            console.log("closeAll");
            let sockets = [];
            this.readSockets.forEach((value, key) => {console.log(key, value); sockets.push(value);});
            this.writeSockets.forEach((value, key) => {console.log(key, value); sockets.push(value[0]);});
            let closePromises = sockets.map(socket => new Promise(resolve => socket.onclose = () => resolve()));
            sockets.forEach(socket => socket.close(1000));
            this.readSockets.clear();
            this.writeSockets.clear();
            await Promise.all(closePromises);
            console.log("closeAll complete");
        }
    }

    const socketCache = new SocketCache();

    class Channel {
        type = null;

        constructor(uuid) {
            this.uuid = uuid;
            this.socket = null;
        }

        hasConnection() {
            return this.socket !== null && this.socket.readyState <= WebSocket.OPEN;
        }

        async connect(onmessage) {
            if (this.hasConnection()) {
                return;
            }
            this.socket = await socketCache.getOrCreate(this.type, this.uuid, onmessage);
            console.log(this.uuid, `Channel connected ${this.type}`);
        }

        async close() {
            console.log(this.uuid, `Channel close ${this.type}`);
            this.socket = null;
            await socketCache.close(this.type, this.uuid);
        }
    }

    class SendChannel extends Channel {
        type = "write";

        async connect() {
            return super.connect(null);
        }

        async _send(cmd, body=null) {
            if (!this.hasConnection()) {
                await this.connect();
            }
            this.socket.send(JSON.stringify([cmd, body]));
        }

        async send(msg) {
            this._send("message", msg);
        }

        async pause() {
            this._send("pause");
        }

        async delete() {
            this._send("delete");
        }
    };
    self.SendChannel = SendChannel;

    const recvChannelsCreated = new Set();

    class RecvChannel extends Channel {
        type = "read";

        constructor(uuid) {
            if (recvChannelsCreated.has(uuid)) {
                throw new Error(`Already created RecvChannel with id ${uuid}`);
            }
            super(uuid);
            this.eventListeners = new Set();
        };

        async connect() {
            if (this.hasConnection()) {
                return;
            }
            await super.connect(event => this.readMessage(event.data));
        }

        readMessage(data) {
            console.log(this.uuid, "RecvChannel readMessage", data);
            let msg = JSON.parse(data);
            this.eventListeners.forEach(fn => fn(msg));
        };

        addEventListener(fn) {
            this.eventListeners.add(fn);
        };

        removeEventListener(fn) {
            this.eventListeners.delete(fn);
        };

        next() {
            return new Promise(resolve => {
                let fn = (msg) => {
                    this.removeEventListener(fn);
                    resolve(msg);
                };
                this.addEventListener(fn);
            });
        }
    }

    self.channel = function() {
        let uuid = createUuid();
        let recvChannel = new RecvChannel(uuid);
        let sendChannel = new SendChannel(uuid);
        return [recvChannel, sendChannel];
    };

    self.start_window = async function() {
        let uuid = self.test_driver_internal._get_context_id(self);
        let channel = new RemoteWindowCommandRecvChannel(new RecvChannel(uuid));
        await channel.connect();
        return channel;
    };

    self.closeAllChannelSockets = async function() {
        await socketCache.closeAll();
        await new Promise(resolve => setTimeout(resolve, 0));
    };

    class RemoteWindowCommandRecvChannel {
        constructor(recvChannel) {
            this.channel = recvChannel;
            this.uuid = recvChannel.uuid;
            this.channel.addEventListener(msg => this.handleMessage(msg));
            this.messageHandlers = new Set();
        };

        async connect() {
            await this.channel.connect();
        }

        async close() {
            await this.channel.close();
        }

        async handleMessage(msg) {
            console.log(this.uuid, "handleMessage", msg);
            const {id, command, params, respChannel} = msg;
            let resp;
            if (command === "executeScript") {
                const fnString = params.fn.value;
                const args = params.args.map(x => {
                    let value = deserialize(x);
                    if (value.constructor === RemoteObject) {
                        value = value.toLocal();
                    }
                    return value;
                });
                const body = `let result = (${fnString}).apply(null, args);
Promise.resolve(result).then(callback);`;
                let value = new Promise(resolve => {
                    const fn = new Function("args", "callback", body);
                    fn(args, value => resolve(value));
                });
                let result, exceptionDetails;
                try {
                    result = serialize(await value);
                } catch(e) {
                    result = serialize(e);
                    const getAsInt = (obj, prop) =>  {
                        let value = parseInt(prop in obj ? obj[prop] : 0);
                        return Number.isNaN(value) ? 0 : value;
                    };
                    exceptionDetails = {
                        text: "" + e.toString(),
                        lineNumber: getAsInt(e, "lineNumber"),
                        columnNumber: getAsInt(e, "columnNumber"),
                    };
                }
                resp = {result};
                if (exceptionDetails) {
                    resp(exceptionDetails) = exceptionDetails;
                }
            } else if (command === "postMessage") {
                this.messageHandlers.forEach(fn => fn(params.msg));
            }
            console.log("result", result);
            if (respChannel) {
                let chan = deserialize(respChannel);
                await chan.connect();
                console.log("Sending result");
                await chan.send({id, result});
            }
        }

        addMessageHandler(fn) {
            this.messageHandlers.add(fn);
        }

        removeMessageHandler(fn) {
            this.messageHandlers.delete(fn);
        }

        nextMessage() {
            return new Promise(resolve => {
                let fn = (msg) => {
                    this.removeEventListener(fn);
                    resolve(msg);
                };
                this.addEventListener(fn);
            });
        }

    }

    class RemoteWindowResponseRecvChannel {
        constructor(recvChannel) {
            this.channel = recvChannel;
            this.channel.addEventListener(msg => this.handleMessage(msg));
            this.responseHandlers = new Map();
        }

        setResponseHandler(commandId, fn) {
            this.responseHandlers.set(commandId, fn);
        }

        handleMessage(msg) {
            let {id, result} = msg;
            let handler = this.responseHandlers.get(id);
            if (handler) {
                this.responseHandlers.delete(id);
                handler(result);
            }
        }

        close() {
            return this.channel.close();
        }
    }

    class RemoteWindow {
        constructor(dest) {
            if (!dest) {
                dest = createUuid();
            }
            if (typeof dest == "string") {
                this.uuid = dest;
                this.sendChannel = new SendChannel(dest);
            } else {
                this.sendChannel = dest;
                this.uuid = dest.uuid;
            }
            this.recvChannel = null;
            this.respChannel = null;
            this.connected = false;
            this.commandId = 0;
        }

        async connect() {
            if (this.connected) {
                return;
            }
            console.log(this.uuid, "RemoteWindow.connect");
            let [recvChannel, respChannel] = self.channel();
            await Promise.all([this.sendChannel.connect(), recvChannel.connect()]);
            this.recvChannel = new RemoteWindowResponseRecvChannel(recvChannel);
            this.respChannel = respChannel;
            this.connected = true;
        }

        async sendMessage(command, params, hasResp=true) {
            console.log(this.uuid, "RemoteWindow.sendMessage", command, params);
            if (!this.connected) {
                await this.connect();
            }
            let msg = {id: this.commandId++, command, params};
            if (hasResp) {
                msg.respChannel = serialize(this.respChannel);
            }
            let response;
            if (hasResp) {
                response = new Promise(resolve =>
                    this.recvChannel.setResponseHandler(msg.id, resolve));
            } else {
                response = Promise.resolve(null);
            }
            this.sendChannel.send(msg);
            return await response;
        }

        _executeScript(fn, args, hasResp) {
            return this.sendMessage("executeScript", {fn: serialize(fn), args: args.map(x => serialize(x))}, hasResp);
        }

        async executeScript(fn, ...args) {
            let resp = await this._executeScript(fn, args, true);
            let value = deserialize(resp);
            return value;
        }

        async executeScriptNoResult(fn, ...args) {
            await this._executeScript(fn, args, false);
        }

        async postMessage(msg) {
            await this.sendMessage("postMessage", {msg}, false);
        }

        pause() {
            console.log("pause");
            // This causes any readers to disconnect until they are explictly reconnected
            return this.sendChannel.pause();
        }

        close() {
            let closers = [this.sendChannel.close()];
            if (this.recvChannel !== null) {
                closers.push(this.recvChannel.close());
            }
            if (this.respChannel !== null) {
                closers.push(this.respChannel.close());
            }
            return Promise.all(closers);
        }
    }

    self.RemoteWindow = RemoteWindow;

    let remoteObjects = new Map();
    let remoteObjectById = new Map();

    function remoteId(obj) {
        let rv;
        if (remoteObjects.has(obj)) {
            rv = remoteObjects.get(obj);
        } else {
            rv = createUuid();
            remoteObjects.set(obj, rv);
            remoteObjectById.set(rv, obj);
        }
        return rv;
    }

    class RemoteObject {
        constructor(type, value, objectId) {
            this.type = type;
            this.value = value;
            this.objectId = objectId;
        }

        toLocal() {
            let toLocalInner = (x) => x instanceof RemoteObject ? x.toLocal() : x;

            switch(this.type) {
            case "function":
                return new Function(this.value);
            case "array":
                return this.value.map(toLocalInner);
            case "set": {
                let rv = new Set();
                this.value.forEach(x => rv.add(toLocalInner(x)));
                return rv;
            }
            case "object": {
                let rv = {};
                for (let [key, value] of Object.entries(this.value)) {
                    rv[key] = toLocalInner(value);
                }
                return rv;
            }
            case "map": {
                let rv = new Map();
                for (let [key, value] of this.value.entries()) {
                    rv.set(key, toLocalInner(value));
                }
                return rv;
            }
            default:
                // Not sure if this should throw; it can be useful to just keep the remote value to
                // return it later
                return this;
            }
        }
    }

    function serialize(obj) {
        console.log("serialize", obj);
        const stack = [{item: obj}];
        let serialized = null;

        while (stack.length > 0) {
            const {item, target, targetKey} = stack.shift();
            // We override this later for non-primitives
            let type = typeof item;
            let objectId;
            let value;

            // The handling of cross-global objects here is broken

            if (item instanceof RemoteObject) {
                type = item.type;
                objectId = item.objectId;
                value = item.value;
            } else {
                switch (type) {
                case "undefined":
                case "null":
                    break;
                case "string":
                case "boolean":
                    value = item;
                    break;
                case "number":
                    if (item !== item) {
                        value = "NaN";
                    } else if (item === 0 && 1/item == Number.NEGATIVE_INFINITY) {
                        value = "-0";
                    } else if (item === Number.POSITIVE_INFINITY) {
                        value = "+Infinity";
                    } else if (item === Number.NEGATIVE_INFINITY) {
                        value = "-Infinity";
                    } else {
                        value = item;
                    }
                    break;
                case "bigint":
                    value = obj.toString();
                    break;
                case "symbol":
                    objectId = remoteId(item);
                    break;
                default:
                    // TODO: Handle platform objects better
                    if (item instanceof RecvChannel) {
                        throw new TypeError("Can't send a RecvChannel");
                    }
                    objectId = remoteId(item);

                    if (item instanceof SendChannel) {
                        type = "sendchannel";
                        value = item.uuid;
                    } else if (Array.isArray(item)) {
                        type = "array";
                        value = [];
                        for (let child of item) {
                            stack.push({item: child, target: value});
                        }
                    } else if (item.constructor.name === "RegExp") {
                        type = "regexp";
                        let pattern = item.source;
                        let flags = item.flags;
                        value = `/{pattern}/{flags}`;
                    } else if (item.constructor.name === "Date") {
                        type = "date";
                        value = Date.prototype.toDateString.call(item);
                    } else if (item.constructor.name === "Map") {
                        type = "map";
                        value = {};
                        for (let [targetKey, child] of item.entries()) {
                            stack.push({item: child, target: value, targetKey});
                        }
                    } else if (item.constructor.name === "Set") {
                        type = "set";
                        value = [];
                        for (let child of item.entries()) {
                            stack.push([{item: child, target: value}]);
                        }
                    } else if (item.constructor.name === "WeakMap") {
                        type = "weakmap";
                    } else if (item.constructor.name === "WeakSet") {
                        type = "weakset";
                    } else if (item instanceof Error) {
                        type = "error";
                    } else if (Promise.resolve(item) === item) {
                        type = "promise";
                    } else if (item instanceof Object.getPrototypeOf(Uint8Array)) {
                        type = "typedarray";
                    } else if (item instanceof ArrayBuffer) {
                        type = "arraybuffer";
                    } else if (type === "function") {
                        value = item.toString();
                    } else {
                        // Treat as a generic object
                        value = {};
                        for (let [targetKey, child] of Object.entries(item)) {
                            stack.push({item: child, target: value, targetKey});
                        }
                    }
                }
            };

            let result = {type};
            if (objectId !== undefined) {
                result.objectId = objectId;
            }
            if (value !== undefined) {
                result.value = value;
            }
            if (target == null) {
                if (serialized !== null) {
                    throw new Error("Tried to create multiple output values");
                }
                serialized = result;
            } else {
                if (Array.isArray(target)) {
                    target.push(result);
                } else {
                    target[targetKey] = target;
                }
            }
        }
        return serialized;
    }

    function deserialize(obj) {
        let deserialized = null;
        let stack = [{item: obj, target: null}];

        while (stack.length > 0) {
            const {item, target, targetKey} = stack.shift();
            const {type, value, objectId} = item;
            let result;
            switch(type) {
            case "undefined":
                result = undefined;
                break;
            case "null":
                result = null;
                break;
            case "string":
            case "boolean":
                result = value;
                break;
            case "number":
                if (typeof value === "string") {
                    switch(value) {
                    case "NaN":
                        result = NaN;
                        break;
                    case "-0":
                        result = -0;
                        break;
                    case "+Infinity":
                        result = Number.POSITIVE_INFINITY;
                        break;
                    case "-Infinity":
                        result = Number.NEGATIVE_INFINITY;
                        break;
                    default:
                        throw new Error(`Unexpected number value "${value}"`);
                    }
                } else {
                    result = value;
                }
                break;
            case "bigint":
                result = BigInt(value);
                break;
            case "array": {
                let remoteValue = [];
                result = new RemoteObject(type, remoteValue, objectId);
                for (let child of value) {
                    stack.push({item: child, target: remoteValue});
                }
                break;
            }
            case "set": {
                let remoteValue = new Set();
                result = new RemoteObject(type, remoteValue, objectId);
                for (let child of value) {
                    stack.push({item: child, target: remoteValue});
                }
                break;
            }
            case "object": {
                let remoteValue = {};
                result = new RemoteObject(type, remoteValue, objectId);
                for (let [targetKey, child] of Object.entries(value)) {
                    stack.push({item: child, target: remoteValue, targetKey});
                }
                break;
            }
            case "map": {
                let remoteValue = new Map();
                result = new RemoteObject(type, remoteValue, objectId);
                for (let [targetKey, child] of Object.entries(value)) {
                    stack.push({item: child, target: remoteValue, targetKey});
                }
                break;
            }
            case "sendchannel": {
                result = new SendChannel(value);
                break;
            }
            default:
                result = new RemoteObject(type, value, objectId);
                break;
            }

            if (target === null) {
                if (deserialized !== null) {
                    throw new Error("Tried to create multiple output values");
                }
                deserialized = result;
            } else if (Array.isArray(target)) {
                target.push(result);
            } else {
                target[0][target[1]] = value;
            }
        }
        return deserialized;
    }

})();
