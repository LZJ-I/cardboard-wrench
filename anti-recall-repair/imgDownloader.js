"use strict";
const { native_image } = require("./lib/native_image");
const { image_cache } = require("./lib/image_cache");
const path = require("node:path");

// 保留上游调用入口，图片下载与缓存状态由专用模块拥有。
class ImgDownloader {
  constructor({ root = path.join(LiteLoader.path.data, "anti_recall", "image_cache"), persist = () => true } = {}) {
    this.native = new native_image();
    this.cache = new image_cache({ root, native: this.native, persist, log: text => this.output(text) });
  }
  observe(contents, args) { this.native.observe(contents, args); }
  prefetch(msg, contents) { this.cache.prefetch(msg, contents); }
  async downloadPic(msg, contents) {
    try { return await this.cache.restore(msg, contents); }
    catch (error) { this.output("图片恢复失败：" + error.message); return false; }
  }
  clear_saved() { return this.cache.clear_saved(); }
  dispose() { this.cache.dispose(); }
  output(...args) { console.log("Anti-Recall:", ...args); }
}
module.exports.ImgDownloader = ImgDownloader;
