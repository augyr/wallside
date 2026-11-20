import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.spatial import cKDTree
rng=np.random.default_rng(11)
W,H=1600,640
# worley F2-F1 caustics, with domain warp for organic shape
def caustic(scale, warp, seed):
    r=np.random.default_rng(seed)
    n=int(W*H/(scale*scale))
    pts=np.c_[r.uniform(-50,W+50,n), r.uniform(-50,H+50,n)]
    tree=cKDTree(pts)
    yy,xx=np.mgrid[0:H,0:W].astype(np.float32)
    wx=xx+warp*np.sin(yy/57.0+seed)+warp*.6*np.sin(xx/91.0+seed*2)
    wy=yy+warp*np.cos(xx/63.0+seed)+warp*.6*np.cos(yy/77.0+seed*3)
    d,_=tree.query(np.c_[wx.ravel(),wy.ravel()],k=2)
    f=(d[:,1]-d[:,0]).reshape(H,W)
    return np.exp(-f/ (scale*0.075))
c=0.55*caustic(80,16,1)+0.40*caustic(130,22,5)
c=np.clip(c,0,1.2)
# base water: graphite with a soft light from upper right
yy,xx=np.mgrid[0:H,0:W]
base=0.11+0.06*np.exp(-(((xx-W*0.75)/(W*0.5))**2+((yy-H*0.05)/(H*0.9))**2))
base-= 0.04*(yy/H)
# caustics stronger near top (closer to surface light)
light=c*(0.16+0.10*(1-yy/H))
img=base+light
# pool floor lane line: dark band + T
band=(np.abs(yy-H*0.72)<18)&(xx<W*0.90)
img[band]*=0.42
tcap=(np.abs(xx-W*0.90)<18)&(np.abs(yy-H*0.72)<80)
img[tcap]*=0.42
g=(np.clip(img,0,1)*255).astype(np.uint8)
rgb=np.dstack([g, (g*1.01).clip(0,255).astype(np.uint8), (g*1.05).clip(0,255).astype(np.uint8)])
im=Image.fromarray(rgb,'RGB')
# swimmer shadow (freestyle, seen from above), drawn large then blurred
S=Image.new('L',(W,H),0); d=ImageDraw.Draw(S)
cx,cy=W*0.52,H*0.40
def P(pts): return [(cx+x,cy+y) for x,y in pts]
# torso (tapered)
d.polygon(P([(-170,-26),(-60,-44),(80,-42),(160,-30),(190,-10),(190,14),(160,32),(80,40),(-60,40),(-170,22)]),fill=255)
# head
d.ellipse([cx+185,cy-30,cx+250,cy+24],fill=255)
# lead arm reaching forward
d.polygon(P([(140,-36),(260,-70),(380,-80),(430,-74),(432,-60),(380,-58),(260,-46),(160,-14)]),fill=255)
d.ellipse([cx+410,cy-84,cx+452,cy-56],fill=255)
# other arm pulling underneath, slightly behind
d.polygon(P([(110,30),(170,70),(220,110),(250,124),(240,138),(205,124),(150,88),(90,44)]),fill=255)
# legs
d.polygon(P([(-160,-24),(-280,-40),(-400,-44),(-430,-36),(-428,-24),(-400,-26),(-280,-18),(-160,6)]),fill=255)
d.polygon(P([(-160,6),(-280,24),(-390,42),(-420,52),(-414,64),(-386,56),(-276,42),(-150,30)]),fill=255)
S=S.rotate(-5,center=(cx,cy),resample=Image.BICUBIC).filter(ImageFilter.GaussianBlur(9))
shadow=np.asarray(S,dtype=np.float32)/255.0
arr=np.asarray(im,dtype=np.float32)
arr*= (1-0.78*shadow)[...,None]
# a second faint shadow offset (depth)
im=Image.fromarray(arr.clip(0,255).astype(np.uint8))
# slight film grain to avoid banding
noise=rng.normal(0,2.2,(H,W,1))
arr=np.asarray(im,dtype=np.float32)+noise
Image.fromarray(arr.clip(0,255).astype(np.uint8)).save('/tmp/gen/pool.jpg',quality=80,optimize=True,progressive=True)
