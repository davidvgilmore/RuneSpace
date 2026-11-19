"""North-up guild map, composited into the terminal renderer's RGBA framebuffer."""

import math

# The same woodland, quarry and buildings as the native Guild HUD.
TREES = ((-10,-6),(-13,-8),(-8,-10),(-12,-3),(-8,-3),(-14,-12),(-10,-14),
         (-5,-16),(3,-17),(9,-16),(15,-13),(17,0),(17,12),(-11,13),(-7,16),(6,17))
ROCKS = ((9,-6),(12,-8),(14,-4),(8,-10),(14,-11),(11,-3))


def rgba(hex_rgb):
    return bytes.fromhex(hex_rgb + 'ff')


EDGE, BRONZE, GILT = map(rgba, ('2d261b', '947348', 'e3bf7a'))
MOSS, GRASS, WATER, TRAIL = map(rgba, ('718053', '788658', '53838e', 'c1ae7d'))
TREE, ORE, ROOF, TIMBER = map(rgba, ('405638','929082','955f46','645746'))
AGENT, ALERT, TEAMMATE, VISITOR, PLAYER = map(rgba, ('f5d36a','ef884e','72ddb1','94c8ef','fff9d9'))


class Minimap:
    def __init__(self):
        self.shape = None

    def resize(self, width, height, hud_scale=1):
        hud_scale = max(.25, min(8, hud_scale))
        if self.shape == (width, height, hud_scale):
            return
        self.shape = (width, height, hud_scale)
        self.hud_scale = hud_scale
        self.size = min(round(120*hud_scale), max(32, width//8), max(30, height//4))
        self.center = (self.size - 1) / 2
        self.radius = self.center - max(3*hud_scale, round(self.size * .07))
        # At this scale even the corners of the walkable 40 × 38 field fit.
        self.scale = self.radius / 28.5
        margin = max(1, round(5*hud_scale))
        self.left, self.top = width-self.size-margin, margin
        self.rows = []
        pixels = bytearray(self.size*self.size*4)
        for y in range(self.size):
            dy = y - self.center
            half = math.sqrt(max(0, self.center**2-dy**2))
            lo, hi = math.ceil(self.center-half), math.floor(self.center+half)
            if hi < lo:
                continue
            src = (y*self.size+lo)*4
            dst = ((y+self.top)*width+self.left+lo)*4
            self.rows.append((src,dst,(hi-lo+1)*4))
            for x in range(lo, hi+1):
                dx = x - self.center
                dist = math.hypot(dx, dy)
                if dist > self.radius:
                    if dist > self.center-hud_scale or dist < self.radius+hud_scale:
                        color = EDGE
                    elif dist > self.center-2.4*hud_scale:
                        color = GILT if dx+dy<0 else BRONZE
                    else:
                        tick = abs(math.sin(16*math.atan2(dy,dx))) < .13
                        color = GILT if tick else BRONZE
                else:
                    wx, wz = dx/self.scale, dy/self.scale
                    color = GRASS if (wx+math.sin(wz*.5)*2)*.3+math.cos(wz*.3)>1 else MOSS
                    if -18.8 < wx < -13.4:
                        color = WATER
                    if (abs(wx)<1.8 and -8.4<wz<20) or (-18.8<wx<14.1 and 1.9<wz<4.1) or wx*wx+(wz-3)**2<50:
                        color = TRAIL
                    if -6.5<wx<6.5 and -13.6<wz<-8.4:
                        color = ROOF if abs(wx)<4.5 else TIMBER
                    if (-9.4<wx<-5.8 and 6.4<wz<9.2) or (8<wx<13.5 and 7.2<wz<9.6):
                        color = TIMBER
                off = (y*self.size+x)*4
                pixels[off:off+4] = color
        for x,z in TREES:
            px,py=self.local(x,z)
            self.dot(pixels,px,py,TREE,round(2*hud_scale))
            self.dot(pixels,px,py+round(2*hud_scale),TIMBER,0)
        for x,z in ROCKS:
            px,py=self.local(x,z)
            self.dot(pixels,px,py,ORE,max(1,round(hud_scale)))
        # A small brass N on the dark compass bezel.
        letter = ('10001','11001','10101','10011','10001')
        letter_width = max(5,round(5*hud_scale))
        left = round(self.center-letter_width/2)
        for y in range(letter_width):
            row = y+round(2*hud_scale)
            start=(row*self.size+left-1)*4
            pixels[start:start+(letter_width+2)*4]=EDGE*(letter_width+2)
            mask=letter[y*5//letter_width]
            for x in range(letter_width):
                if mask[x*5//letter_width]=='1':
                    self.dot(pixels,left+x,row,GILT,0)
        self.terrain = bytes(pixels)
        self.pixels = memoryview(pixels)
        self.next_update = 0

    def local(self, x, z):
        return round(self.center+x*self.scale), round(self.center+z*self.scale)

    def contains(self, point):
        dx = point[0]-self.left-self.center
        dy = point[1]-self.top-self.center
        return dx*dx+dy*dy <= self.center*self.center

    def destination(self, point):
        x = (point[0]-self.left-self.center)/self.scale
        z = (point[1]-self.top-self.center)/self.scale
        return [max(-20,min(20,x)), max(-19,min(19,z))]

    def dot(self, pixels, x, y, color, radius):
        for dy in range(-radius, radius+1):
            row = y+dy
            if 0 <= row < self.size:
                span = radius-abs(dy)
                lo, hi = max(0,x-span), min(self.size,x+span+1)
                if hi > lo:
                    off = 4*(row*self.size+lo)
                    pixels[off:off+4*(hi-lo)] = color*(hi-lo)

    def compose(self, raw, frame, now):
        if now >= self.next_update:
            self.pixels[:] = self.terrain
            radius = max(1,round(self.hud_scale))
            rim = max(radius+1,round(2*self.hud_scale))
            for agent in frame['agents']:
                x,y = self.local(agent['worldX'],agent['worldZ'])
                color = ALERT if agent['status'] in ('blocked','error') else AGENT
                self.dot(self.pixels,x,y,EDGE,rim)
                self.dot(self.pixels,x,y,color,radius)
            for visitor in frame.get('visitingAgents', []):
                x,y = self.local(visitor['x'],visitor['z'])
                self.dot(self.pixels,x,y,EDGE,rim)
                self.dot(self.pixels,x,y,VISITOR,radius)
            for teammate in frame.get('teamCharacters', []):
                x,y = self.local(teammate['x'],teammate['z'])
                self.dot(self.pixels,x,y,EDGE,rim)
                self.dot(self.pixels,x,y,TEAMMATE,radius)
            x,y = self.local(frame['x'],frame['z'])
            heading = frame['yaw']
            for step in range(max(1,round(5*self.hud_scale))):
                tip_radius = rim if step < 2*self.hud_scale else radius if step < 4*self.hud_scale else 0
                px = round(x-math.sin(heading)*step)
                py = round(y-math.cos(heading)*step)
                self.dot(self.pixels,px,py,PLAYER,tip_radius)
            self.next_update = now+.1
        for src,dst,length in self.rows:
            raw[dst:dst+length] = self.pixels[src:src+length]
