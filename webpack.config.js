var webpack = require('webpack');

module.exports = {
  context: __dirname,
  devtool: false,
  entry: "./test.js",
  mode: 'development',
  output: {
    path: __dirname + "/output",
    filename: "index.js"
  },
  plugins: [],
};