from PIL import Image, ImageDraw, ImageFont, ImageFilter
import glob
W,H=1200,630
bg=Image.open('/home/claude/wallside/web/img/pool.jpg').convert('RGB')
r=max(W/bg.width,H/bg.height); bg=bg.resize((int(bg.width*r)+1,int(bg.height*r)+1),Image.LANCZOS)
x=(bg.width-W)//2; bg=bg.crop((x,0,x+W,H))
ov=Image.new('RGBA',(W,H),(13,13,14,0)); d=ImageDraw.Draw(ov)
for i in range(H): d.line([(0,i),(W,i)],fill=(13,13,14,int(70+90*i/H)))
im=Image.alpha_composite(bg.convert('RGBA'),ov)
d=ImageDraw.Draw(im)
anton=glob.glob('/usr/share/fonts/truetype/google-fonts/ofl/anton/*.ttf')[0]
dm=glob.glob('/usr/share/fonts/truetype/google-fonts/ofl/dmsans/*.ttf')[0]
ft=ImageFont.truetype(anton,150); fs=ImageFont.truetype(dm,40)
try: fs.set_variation_by_axes([14,600])
except Exception: pass
d.text((80,200),"Wallside",font=ft,fill='white')
d.text((84,400),"Practice notes, meet times and progress —",font=fs,fill=(220,222,226))
d.text((84,452),"one place for coach, swimmer and family.",font=fs,fill=(220,222,226))
# lane rope
y=H-46
d.rectangle([0,y+2,W,y+4],fill=(42,43,46))
xx=4;i=0
while xx<W:
    col=(244,244,245) if i%4==3 else (208,32,44)
    d.rounded_rectangle([xx,y,xx+22,y+8],radius=4,fill=col); xx+=26;i+=1
im.convert('RGB').save('/home/claude/wallside/web/img/share.jpg',quality=85,optimize=True)
