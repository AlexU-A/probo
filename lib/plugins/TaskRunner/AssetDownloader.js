"use strict";

module.exports = class AssetDownloader extends require('./Script') {
  /**
   * options (used by this task):
   *   - asset_server_url: URL (protocol, server and port) of asset server
   *   - asset_bucket: asset bucket
   *   - assets: array of assets to download. Each asset is a string (same id and filename) or
   *             a {asset id: filename} object
   *
   */
  constructor(container, options) {
    super(container, options)

    // don't do anything if there aren't any assets or bucket specified
    if(!options.asset_bucket || !options.assets){
      return this
    }

    // filter out asset tokens
    options.secrets = [
      options.asset_bucket
    ]

    var script = [
      "mkdir /assets",
      "cd /assets",
    ]

    // create a download command for every asset
    for(let asset of options.assets){
      script.push(this.createAssetDownloadCommand(asset))
    }

    this.setScript(script)  // Script::setScript()
  }

  /**
   * Takes a string or an {id: filename} object and returns an object with
   * {id: id, name: name} mapping
   */
  normalizeAsset(asset){
    var id, name

    if(typeof asset == "string"){
      id = name = asset
    } else {
      id = Object.keys(asset)[0]
      name = asset[id]
    }

    return {id, name}
  }

  createAssetDownloadCommand(asset){
    var url = this.options.asset_server_url
    var bucket = this.options.asset_bucket
    asset = this.normalizeAsset(asset)
    return `wget -nv -O ${asset.name} ${url}/asset/${bucket}/${asset.id}`
  }
}
