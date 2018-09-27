/* global Promise */
var _ = require('lodash');

var utils = require('./utils');

function Connector(options) {
  this.options = options;
}

Connector.prototype.disconnect = function () {
  this.connecting = false;
  if (this.socket) {
    this.socket.close();
  }
};

Connector.prototype.connect = function (callback) {
  this.connecting = true;  
  var endpoint = this.options.endpoint;

  var _this = this;
  setTimeout(function () {
    if (!_this.connecting) {
      callback(new utils.TarantoolError('Connection is closed.'));
      return;
    }
    var socket;
    try {
      socket = new WebSocket(endpoint);
    } catch (err) {
      callback(err);
      return;
    }
    _this.socket = socket;
    callback(null, socket);
  }, 0);
};

module.exports = Connector;