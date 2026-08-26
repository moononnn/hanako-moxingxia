// 模型匣 —— 插件生命周期入口
// 纪律：onload 只做轻量注册，不做重活（坑 48/49：onload 超时会丢插件）

export default class Plugin {
  async onload() {
    this.ctx.log.info("[模型匣] loaded");
  }

  async onunload() {
    this.ctx.log.info("[模型匣] unloaded");
  }
}