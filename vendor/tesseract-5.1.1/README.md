# Tesseract.js 5.1.1（本地副本）

编辑器的“截图自动识别金额”用到的文字识别库。放在仓库里而不是从 CDN 加载：编辑器页面里有密码、token 和解密后的数据，不引入第三方服务器上的脚本；识别也完全在浏览器本地进行，截图不会离开本机。

只有在编辑器里选择截图时才会加载，查看页不会用到。文件与 npm 包内容逐字节相同，未做修改：

| 文件 | 来源（npm 包） |
|---|---|
| `tesseract.esm.min.js`、`worker.min.js`、`LICENSE.md` | `tesseract.js@5.1.1` 的 `dist/` 和根目录 |
| `tesseract-core-simd-lstm.wasm.js`、`tesseract-core-lstm.wasm.js` | `tesseract.js-core@5.1.1`（前者给支持 WebAssembly SIMD 的浏览器，后者给不支持的） |
| `lang/chi_sim.traineddata.gz` | `@tesseract.js-data/chi_sim@1.0.0` 的 `4.0.0_best_int/` |
| `lang/eng.traineddata.gz` | `@tesseract.js-data/eng@1.0.0` 的 `4.0.0_best_int/` |

许可证：Tesseract.js、Tesseract 及其语言数据均为 Apache License 2.0（见 `LICENSE.md`）。

升级时新建一个带新版本号的目录，并修改 `ocr.js` 里的 `VENDOR` 路径。
