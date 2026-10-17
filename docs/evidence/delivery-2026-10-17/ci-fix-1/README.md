# Docker 构建输入补充验证

首轮提交 `6288c20` 的 [Docker CI 作业](https://github.com/liaboveall/Agent-BL-Upgrade/actions/runs/39006640376/job/117320346731) 在 Vite 构建阶段失败：`web/src/lib/market.js` 引用了共享认购准入模块，但 Dockerfile 的前端阶段只复制 `web/` 与 `public/`，没有 `src/core/`。原始失败日志保留在 `docker-first-run.log`。

已在原构建阶段增加 `COPY src/core ./src/core`。仅复制该阶段的 package/锁文件、web、public 与 src/core，在独立目录复用已干净安装的 Linux 依赖，Vite 构建通过，见 `isolated-web-build.log`。本地 Docker daemon 不可用，这份检查仅证明构建输入可解析，不冒充 Alpine 镜像构建或容器健康检查；后续同一提交的远程 Docker CI 必须通过。

原 [干净目录应用、合约、浏览器及评测记录](../README.md) 保留；应用和测试源码没有变化，原逐文件清单仍适用。本目录 `local-validation.json` 追加 Dockerfile 与 .dockerignore 的哈希。远程首轮失败不因后续修复而删除或覆盖。
