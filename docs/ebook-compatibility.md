# 免费发行电子书兼容性验证

验证日期：2026-09-13。使用与正式程序相同源码和打包前端的 Windows 独立测试程序，单独的应用标识与空白数据目录。下载文件没有转换正文，未使用个人书库。

| 书籍与来源 | 实际下载格式 | 文件数 | 结果 |
| --- | --- | ---: | --- |
| [Alice’s Adventures in Wonderland — Project Gutenberg](https://www.gutenberg.org/ebooks/11) | MOBI、KF8、EPUB 2、EPUB 3、HTML | 5 | 导入、存储、阅读跳转与目录操作通过 |
| [紅樓夢 — Project Gutenberg](https://www.gutenberg.org/ebooks/24264) | MOBI、KF8、EPUB 3 | 3 | 导入、存储、阅读跳转与目录操作通过 |
| [Little Brother — 作者 Cory Doctorow 官网](https://craphound.com/littlebrother/download/) | MOBI、PRC、FB2、EPUB | 4 | 阅读通过；PRC 源文件没有结构化目录 |
| [Война и мир（战争与和平）— 托尔斯泰项目](https://www.tolstoy.ru/creativity/fiction/index.php) | MOBI、FB2、EPUB | 3 | 导入、存储、阅读跳转与目录操作通过 |

共 15 份文件，覆盖中文、英文和俄文，以及不同年代、不同制作工具的文件。每份检查本地导入与存储、50% 和 100% 阅读跳转、章节目标有效性；有目录者实际点击一个中间目录条目。还从同一本书的 EPUB 抽取五个位置的片段，与其他格式的正文比对。

Project Gutenberg 的 KF8 下载使用 `.mobi` 文件名，测试按其实际 KF8 内容保存为 `.azw3`，没有重新制作或转换文件。Standard Ebooks 的一个 AZW3 下载返回了非电子书内容，已拒绝保存，不计入通过样本。

## 发现与核对

- 带普通 `<link>` 的 Gutenberg KF8 文件触发第三方解析器的资源渲染错误。已改为直接重建并提取章节文本，跳过不需要的图片、字体、样式资源处理；添加回归测试，15 份样本重新验证通过。
- 《红楼梦》的 EPUB/KF8 与旧 MOBI 下载正文不同。用 Calibre 独立读取同一份 MOBI，剔除空白和标点后的全文字符序列与阅读器完全一致。
- 《Little Brother》PRC 源文件没有标题标签、内部目录链接或目录引用。它的正文与 Calibre 独立读取结果一致；不凭空生成出版物目录。
- 《战争与和平》FB2 与 Calibre 的对照差异为 Calibre 自动生成的目录和 `Notes` 字样，除此以外正文字符序列一致。跨格式抽查存在版本差异，不能把字符总数不同直接视为解析丢失。

这是样本兼容性验证，不代表所有 DRM-free 文件变体均已覆盖。没有取得真实 AZW 下载，因此没有把扩展名别名测试计为新的 AZW 发行样本。

## 样本与复现

运行 `python scripts/download-public-ebooks.py` 下载到被 Git 忽略的 `artifacts/real-ebooks/books/`。来源、最终下载地址、字节数与 SHA-256 保存于同目录上一级的 `sources.json`；书籍文件不会加入源码或 Release。

测试程序需使用独立标识构建。将以下 JSON 保存到 `artifacts/real-ebooks/test-config.json`：

```json
{"identifier":"app.terminalreader.compatibilitytest","bundle":{"createUpdaterArtifacts":false}}
```

```sh
node node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle --config artifacts/real-ebooks/test-config.json
node scripts/verify-public-ebooks.mjs
```

测试脚本检查独立标识，避免把样本转交给正在使用的阅读器。结果保存到 `artifacts/real-ebooks/results.json`，其中路径只属于临时测试目录，不应作为公开发布附件。
