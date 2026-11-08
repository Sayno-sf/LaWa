"""单个视觉原件的隔离渲染进程；不继承模型凭据，输出最大 3 MiB。"""
import base64
import json
import sys
from pathlib import Path
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.material_visuals import render

if __name__ == "__main__":
    try:
        source, fmt, asset, output = sys.argv[1:5]
        data = render(Path(source), fmt, json.loads(asset))
        Path(output).write_text(json.dumps({"mime": "image/jpeg", "data": base64.b64encode(data).decode()}), encoding="utf-8")
    except Exception as error:
        print(str(error)[:200], file=sys.stderr)
        raise SystemExit(2)
