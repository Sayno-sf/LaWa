# RapidOCR 历史评估归属

本产品已停用本地 OCR，`requirements.txt` 不再安装 RapidOCR 或 ONNX Runtime。此目录只保留历史兼容和许可证记录：旧缓存可以只读回显已有机器转录，新资料由有视觉能力的教学模型直接读取原 PDF/页图。

RapidOCR 代码版权归 RapidOCR Authors；本次三份 PaddleOCR 衍生模型版权归 Baidu 和/或相应 PaddleOCR 权利人。代码及该清单内模型分别按 Apache-2.0 使用，参见随 3.10.0 安装包原样保存的 [LICENSE](LICENSE) 和 [MODEL_LICENSES.md](MODEL_LICENSES.md)。二者的 SHA-256 分别为 `3e0af25fdd06aa9586ae97adb00ea927ebe5a3805ac77d2d3a81ce5f55693333`、`c5fd0e8603d3df743355b546121e6fe0f4ef8ff455c5a85c1681fd3ae520e153`。

本地程序只加载并校验授权清单中的 `PP-OCRv6_det_small.onnx`、`PP-OCRv6_rec_small.onnx`、`ch_ppocr_mobile_v2.0_cls_mobile.onnx`。模型哈希见清单及 `app/material_ocr.py`；实际权重保存在 Python 依赖环境中，未复制进 Git。

分发相关组件时附上许可证、保留适用版权/归属/NOTICE，并标明修改。更换模型应重新核对授权和模型身份。本说明不将字体、样本图片、ONNX Runtime 或其他依赖改为 Apache-2.0，也不改变本产品其他代码的授权；依赖安装包自带的许可证/第三方声明应保留。

来源：[RapidOCR 固定提交](https://github.com/RapidAI/RapidOCR/tree/0700743fc8bfb3943cd8e40e84547f14c7d15dfc)、[3.10.0 发布](https://pypi.org/project/rapidocr/3.10.0/)。
