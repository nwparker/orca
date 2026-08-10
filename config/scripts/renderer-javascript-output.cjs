const JAVASCRIPT_OUTPUT_PATTERN = /\.(?:[cm]?js)$/
const RAW_JAVASCRIPT_SOURCE_MAP_PATTERN = /\.(?:[cm]?js)\.map$/
const COMPRESSED_JAVASCRIPT_SOURCE_MAP_PATTERN = /\.(?:[cm]?js)\.map\.gz$/

function isJavaScriptOutputPath(fileName) {
  return JAVASCRIPT_OUTPUT_PATTERN.test(fileName)
}

function isRawJavaScriptSourceMapPath(fileName) {
  return RAW_JAVASCRIPT_SOURCE_MAP_PATTERN.test(fileName)
}

function isCompressedJavaScriptSourceMapPath(fileName) {
  return COMPRESSED_JAVASCRIPT_SOURCE_MAP_PATTERN.test(fileName)
}

module.exports = {
  isCompressedJavaScriptSourceMapPath,
  isJavaScriptOutputPath,
  isRawJavaScriptSourceMapPath
}
