"""隔离验收扫描资料；只生成已知内容，不读写用户资料或学习账本。"""
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont

target = Path(sys.argv[1]); target.mkdir(parents=True, exist_ok=True)
page = Image.new("RGB", (1400, 1600), "white")
draw = ImageDraw.Draw(page)
font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 32)
heading = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 40)
draw.text((70, 50), "Solar wind and Earth's magnetosphere", font=heading, fill="black")
lines = ["The solar wind consists of charged particles from the Sun.",
         "Solar wind compresses the magnetosphere on the day side.",
         "Charged particles guided by the magnetosphere enter", "the upper atmosphere and produce auroras."]
for i, line in enumerate(lines): draw.text((70, 135 + i * 55), line, font=font, fill="black")
draw.text((70, 420), "Kinetic energy formula: E = (1/2) m v^2", font=font, fill="black")
for y in (540, 620, 700, 780): draw.line((70, y, 1050, y), fill="black", width=3)
for x in (70, 450, 750, 1050): draw.line((x, 540, x, 780), fill="black", width=3)
for y, row in [(560, ["Condition", "Speed (km/s)", "Density"]), (640, ["Quiet", "400", "5"]), (720, ["Fast", "800", "3"])]:
    for x, value in zip((90, 470, 780), row): draw.text((x, y), value, font=font, fill="black")
draw.text((70, 880), "Schematic: solar wind interacts with magnetosphere", font=font, fill="black")
draw.text((100, 1020), "Solar wind", font=font, fill="black")
draw.line((110, 1120, 800, 1120), fill="black", width=5)
draw.polygon([(800, 1120), (775, 1100), (775, 1140)], fill="black")
draw.ellipse((840, 980, 1240, 1320), outline="black", width=4)
draw.text((900, 1130), "Earth", font=font, fill="black")
draw.text((890, 950), "Magnetosphere", font=font, fill="black")
page.save(target / "solar-scan.pdf", "PDF", resolution=120)
page.save(target / "solar-image.png")
(target / "aurora.txt").write_text("Magnetosphere directs charged particles into the upper atmosphere.\nCharged particles collide with oxygen and nitrogen in the upper atmosphere, producing auroras.\nOxygen emits green and red light; nitrogen emits blue and purple light.\n", encoding="utf-8")
