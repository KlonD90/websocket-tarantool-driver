/* global Promise */

var EventEmitter = require('eventemitter3');
var inherits = require('util.inherits');
var msgpack = require('msgpack-lite');
var debug = require('debug')('tarantool-driver:main');
var _ = require('lodash');

var utils = require('./utils');
var Denque = require('denque');
var tarantoolConstants = require('./const');
var Commands = require('./commands');
var Connector = require('./connector');
var eventHandler = require('./event-handler');
var SliderBuffer = require('./sliderBuffer')
var multiplierBuffer = 2;
var toArrayBuffer = require('to-arraybuffer')

var Decoder = require("msgpack-lite").Decoder;
var decoder = new Decoder();

var revertStates = {
    0: 'connecting',
    1: 'connected',
    2: 'awaiting',
    4: 'inited',
    8: 'prehello',
    16: 'awaiting_length',
    32: 'end',
    64: 'reconnecting',
    128: 'auth',
    256: 'connect'
};
TarantoolConnection.defaultOptions = {
    endpoint: '',
    username: null,
    password: null,
    retryStrategy: function (times) {
        return Math.min(times * 50, 2000);
    },
    lazyConnect: false
};

function TarantoolConnection (){
    if (!(this instanceof TarantoolConnection)) {
        return new TarantoolConnection(arguments[0], arguments[1], arguments[2]);
    }
    EventEmitter.call(this);
    this.parseOptions(arguments[0], arguments[1], arguments[2]);
    this.connector = new Connector(this.options);
    this.schemaId = null;
    this.msgpack = msgpack; 
    this.states = {
        CONNECTING: 0,
        CONNECTED: 1,
        AWAITING: 2,
        INITED: 4,
        PREHELLO: 8,
        AWAITING_LENGTH: 16,
        END: 32,
        RECONNECTING: 64,
        AUTH: 128,
        CONNECT: 256
    };
    this.dataState = this.states.PREHELLO;
    this.commandsQueue = new Denque();
    this.offlineQueue = new Denque();
    this.namespace = {};
    this.bufferSlide = new SliderBuffer()
    this.awaitingResponseLength = -1;
    this.retryAttempts = 0;
    this._id = 0;
    if (this.options.lazyConnect) {
        this.setState(this.states.INITED);
    } else {
        this.connect().catch(_.noop);
    }
}

inherits(TarantoolConnection, EventEmitter);
_.assign(TarantoolConnection.prototype, Commands.prototype);
_.assign(TarantoolConnection.prototype, require('./parser'));

TarantoolConnection.prototype.resetOfflineQueue = function () {
  this.offlineQueue = new Denque();
};

TarantoolConnection.prototype.parseOptions = function(){
    this.options = {};
    var i;
    for (i = 0; i < arguments.length; ++i) {
        var arg = arguments[i];
        if (arg === null || typeof arg === 'undefined') {
            continue;
        }
        if (typeof arg === 'object') {
            _.defaults(this.options, arg);
        } else if (typeof arg === 'string') {
            _.defaults(this.options, {endpoint: arg});
        } else {
            throw new utils.TarantoolError('Invalid argument ' + arg);
        }
    }
    _.defaults(this.options, TarantoolConnection.defaultOptions);
};

TarantoolConnection.prototype.sendCommand = function(command, cmdBuffer){
    switch (this.state){
        case this.states.INITED:
            this.connect().catch(_.noop);
        case this.states.CONNECT:
            if(!this.socket || this.socket.readyState !== 1){
                debug('queue -> %s(%s)', command[0], command[1]);
		        this.offlineQueue.push([command, cmdBuffer]);
            }else{
                this.commandsQueue.push(command);
                this.socket.send(toArrayBuffer(cmdBuffer));
            }
            break;
        case this.states.END:
            command[2].reject(new utils.TarantoolError('Connection is closed.'));
            break;
        default:
            debug('queue -> %s(%s)', command[0], command[1]);
		    this.offlineQueue.push([command, cmdBuffer]);
    }
};

TarantoolConnection.prototype.setState = function (state, arg) {
    var address;
    if (this.socket && this.socket.remoteAddress && this.socket.remotePort) {
        address = this.socket.remoteAddress + ':' + this.socket.remotePort;
    } else {
        address = this.options.host + ':' + this.options.port;
    }
    debug('state[%s]: %s -> %s', address, revertStates[this.state] || '[empty]', revertStates[state]);
    this.state = state;
    setTimeout(this.emit.bind(this, revertStates[state], arg), 0);
};

TarantoolConnection.prototype.connect = function(){
    return new Promise(function (resolve, reject) {
        if (this.state === this.states.CONNECTING || this.state === this.states.CONNECT || this.state === this.states.CONNECTED || this.state === this.states.AUTH) {
            reject(new utils.TarantoolError('Tarantool is already connecting/connected'));
            return;
        }
        this.setState(this.states.CONNECTING);
        var _this = this;
        this.connector.connect(function(err, socket){
            if(err){
                _this.flushQueue(err);
                _this.silentEmit('error', err);
                reject(err);
                _this.setState(_this.states.END);
                return;
            }
            _this.socket = socket;
            console.log(socket)
            socket.onopen = eventHandler.connectHandler(_this);
            socket.onerror = eventHandler.errorHandler(_this);
            socket.onclose = eventHandler.closeHandler(_this);
            socket.onmessage = eventHandler.dataHandler(_this);

            var connectionConnectHandler = function () {
                _this.removeListener('close', connectionCloseHandler);
                resolve();
            };
            var connectionCloseHandler = function () {
                _this.removeListener('connect', connectionConnectHandler);
                reject(new Error('Connection is closed.'));
            };
            _this.once('connect', connectionConnectHandler);
            _this.once('close', connectionCloseHandler);
        });
    }.bind(this));
};

TarantoolConnection.prototype.flushQueue = function (error) {
    while (this.offlineQueue.length > 0) {
        this.offlineQueue.shift()[0][2].reject(error);
    }
    while (this.commandsQueue.length > 0) {
        this.commandsQueue.shift()[2].reject(error);
    }
};

TarantoolConnection.prototype.silentEmit = function (eventName) {
  var error;
  if (eventName === 'error') {
    error = arguments[1];

    if (this.status === 'end') {
      return;
    }

    if (this.manuallyClosing) {
      if (
        error instanceof Error &&
        (
          error.message === utils.CONNECTION_CLOSED_ERROR_MSG ||
          error.syscall === 'connect' ||
          error.syscall === 'read'
        )
      ) {
        return;
      }
    }
  }
  if (this.listeners(eventName).length > 0) {
    return this.emit.apply(this, arguments);
  }
  if (error && error instanceof Error) {
    console.error('[tarantool-driver] Unhandled error event:', error.stack);
  }
  return false;
};
TarantoolConnection.prototype.destroy = function () {
  this.disconnect();
};
TarantoolConnection.prototype.disconnect = function(reconnect){
    if (!reconnect) {
        this.manuallyClosing = true;
    }
    if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
    }
    if (this.state === this.states.INITED) {
        eventHandler.closeHandler(this)();
    } else {
        this.connector.disconnect();
    }
};

TarantoolConnection.prototype.IteratorsType = tarantoolConstants.IteratorsType;

module.exports = TarantoolConnection; 