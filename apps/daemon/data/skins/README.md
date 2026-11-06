# 随包皮肤资源

`bundled/interstellar-night/` 是随包提供的「星际 · 静谧星海」初始皮肤，包含 skin.json、theme.css、theme.js 和本地 WebP 背景，不依赖用户配置目录或网络下载。桌面打包的 build-backend.sh / build-backend.ps1 递归复制 daemon/data；Docker 运行时同样包含这份数据。

`services/skins.py::BUNDLED_SKINS` 登记初始包；daemon 启动调用 `skin_manager.ensure_defaults()`，在工作线程中将包复制到 `$WORKSTEP_CONFIG_DIR/runtime/skin-packages/interstellar-night/` 并走普通皮肤注册流程。复制后的 JSON、CSS、脚本和图片都可以修改，编辑后可重新注册同一 ID；可以导出、替换或删除，没有只读内置保护。

初始化只在运行时源目录不存在时执行。已有同名安装则从其当前快照复制，保留用户版本；源目录已有内容时不覆盖，应用升级也不强制更新。界面删除皮肤只删除注册指针，保留可编辑源目录，所以下次启动不会重新注册用户删掉的皮肤。分发目录仅提供初始文件，界面读取、脚本及资源均来自已注册运行时快照。默认皮肤仍为初始选择，脚本仍由外观设置开关控制。

背景图片来源：[ESO/S. Brunier — The Milky Way panorama (eso0932a)](https://www.eso.org/public/images/eso0932a/)，许可 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。包内图片为 AI 辅助融合星云、冷蓝调色、裁切和 WebP 压缩后的改编，原图未宣称由 AI 生成。可见署名和 CSS 注释保留来源及改编说明，完整第三方说明见仓库 THIRD_PARTY_NOTICES.md（桌面包同时携带）。
