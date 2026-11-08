"""用真实图片资源生成约 50 MB 的 PDF/PPTX；正文/定位有独立预期，图像不冒充可读文字。"""
import io
import json
from pathlib import Path
import random
import sys
from PIL import Image
from pptx import Presentation
from pptx.util import Inches
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
images = []
for n in range(5):
    pixels = random.Random(20261003+n).randbytes(1800*1800*3)
    image = Image.frombytes("RGB", (1800,1800), pixels)
    binary = io.BytesIO()
    image.save(binary, format="PNG")
    images.append(binary.getvalue())
deck = Presentation()
for n, image in enumerate(images):
    slide = deck.slides.add_slide(deck.slide_layouts[6])
    box = slide.shapes.add_textbox(Inches(1), Inches(.3), Inches(8), Inches(.5))
    box.text_frame.text = f"LARGE_SLIDE_{n+1}: semantic retrieval uses local indexes."
    slide.shapes.add_picture(io.BytesIO(image), Inches(1), Inches(1), width=Inches(5))
    slide.notes_slide.notes_text_frame.text = f"NOTE_{n+1}: images are not OCR text."
deck.save(root / "large.pptx")
pdf = canvas.Canvas(str(root / "large.pdf"))
for n, image in enumerate(images[:4]):
    pdf.drawString(40,800,f"LARGE_PAGE_{n+1}: local parsing preserves true page locations.")
    pdf.drawImage(ImageReader(io.BytesIO(image)), 40,200,width=500,height=500)
    pdf.showPage()
pdf.save()
(root / "large-fixtures.json").write_text(json.dumps({
    "pdf": {"bytes": (root/"large.pdf").stat().st_size, "units": 4, "markers": [f"LARGE_PAGE_{n+1}" for n in range(4)]},
    "pptx": {"bytes": (root/"large.pptx").stat().st_size, "units": 5, "markers": [f"LARGE_SLIDE_{n+1}" for n in range(5)]},
}), encoding="utf-8")
