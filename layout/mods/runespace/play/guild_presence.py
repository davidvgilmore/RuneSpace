"""Exchange poses with the persistent guild call and composite its RGBA video tiles."""
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time

SLOTS = ('head', 'cape', 'torso', 'weapon', 'shield', 'legs', 'boots')
TILE = re.compile(r'tile-[a-zA-Z0-9_-]{1,80}\.rgba\Z')


def number(value):
    return type(value) in (float, int) and math.isfinite(value)


def peers_for_renderer(peers):
    result = []
    for peer in (peers if isinstance(peers, list) else [])[:32]:
        if not isinstance(peer, dict) or not all(number(peer.get(k)) for k in ('x','z','yaw')):
            continue
        identity, name = peer.get('id'), peer.get('name')
        if not isinstance(identity, str) or not identity or not isinstance(name, str):
            continue
        actor = {key:peer[key] for key in ('x','z','yaw')}
        actor.update(id=identity[:80], name=name[:32], moving=peer.get('moving') is True,
                     activity=peer.get('activity') if peer.get('activity') in ('wood','attack','dance') else 'idle')
        gear = peer.get('loadout')
        if isinstance(gear, dict):
            actor['loadout'] = {k:gear[k][:60] for k in SLOTS if isinstance(gear.get(k), str)}
        result.append(actor)
    return result


class GuildPresence:
    def __init__(self, data):
        self.directory = Path(data) / 'runespace-social'
        self.next_read = self.next_write = 0
        self.stamp = self.sent_peers = self.previous_pose = None
        self.agent_update = self.binding_stamp = self.sent_agents = self.sent_stations = None
        self.bindings = {}
        self.last_heartbeat = 0
        self.member_count = 0
        self.tiles = []
        self.state = {}
        self.tile_cache = {}

    def read(self, request, now):
        if now < self.next_read:
            return
        self.next_read = now + .1
        path = self.directory / 'state.json'
        try:
            stamp = path.stat().st_mtime_ns
            if stamp != self.stamp:
                state = json.loads(path.read_bytes())
                self.state = state if isinstance(state, dict) else {}
                self.stamp = stamp
        except (OSError, ValueError):
            self.stamp = None
            self.state = {}
        stamp = self.state.get('updatedAt')
        online = self.state.get('status') == 'connected' and number(stamp) and abs(time.time()-stamp) < 8
        actors = peers_for_renderer(self.state.get('peers')) if online else []
        identity = self.state.get('self', '') if online else ''
        members = (identity, actors)
        if members != self.sent_peers:
            request.update(teamPeers=actors, teamSelf=identity if isinstance(identity, str) else '')
            self.sent_peers = members
        self.read_agents(request, online)
        self.member_count = len(actors) + 1 if online else 0
        self.read_tiles(self.state.get('tiles') if online else [])

    def read_agents(self, request, online):
        file = self.directory/'agent-bindings.json'
        try:
            stamp = file.stat().st_mtime_ns if online else None
            if stamp != self.binding_stamp:
                data = json.loads(file.read_bytes()) if online else {}
                self.bindings = data if isinstance(data,dict) else {}
                self.binding_stamp = stamp
        except (OSError,ValueError):
            self.bindings = {}
            self.binding_stamp = None
        revision = (self.stamp, self.binding_stamp, online)
        if revision == self.agent_update:
            return
        self.agent_update = revision
        for field in ('guildAgents','guildStations'):
            rows = self.state.get(field) if online else []
            result = []
            for row in (rows if isinstance(rows,list) else [])[:2048]:
                if not isinstance(row,dict) or not isinstance(row.get('id'),str):
                    continue
                if not all(number(row.get(k)) for k in ('x','z','yaw')) or abs(row['x'])>20 or abs(row['z'])>19:
                    continue
                pose = {k:row[k] for k in ('x','z','yaw')}
                pose['activity'] = row.get('activity') if row.get('activity') in ('wood','fish','smith','mine','farm','waiting','blocked','error','unknown') else 'idle'
                pose['moving'] = row.get('moving') is True
                if field=='guildStations':
                    key = self.bindings.get(row['id'])
                    if not isinstance(key,str) or not key:
                        continue
                    pose['key'] = key
                else:
                    fields = ('name','kind','status','ownerName')
                    if not all(isinstance(row.get(k),str) for k in fields):
                        continue
                    pose.update({k:row[k][:64] for k in fields},id=row['id'][:80])
                result.append(pose)
            before = self.sent_agents if field=='guildAgents' else self.sent_stations
            if result != before:
                request[field] = result
                if field=='guildAgents': self.sent_agents = result
                else: self.sent_stations = result

    def read_tiles(self, tiles):
        visible = [t for t in (tiles if isinstance(tiles, list) else []) if isinstance(t, dict)
                   and t.get('video') and isinstance(t.get('file'), str) and TILE.fullmatch(t['file'])]
        cache = {}
        result = []
        for tile in sorted(visible, key=lambda t: bool(t.get('local')))[:4]:
            width, height = tile.get('width'), tile.get('height')
            if type(width) is not int or type(height) is not int or not (8 <= width <= 320 and 8 <= height <= 180):
                continue
            path = self.directory / tile['file']
            try:
                stat = path.stat()
                if stat.st_size != width*height*4:
                    continue
                old = self.tile_cache.get(path)
                pixels = old[1] if old and old[0] == stat.st_mtime_ns else memoryview(path.read_bytes())
                if len(pixels) != stat.st_size:
                    continue
                cache[path] = (stat.st_mtime_ns, pixels)
            except OSError:
                continue
            result.append((width, height, pixels, tile.get('speaking') is True))
        self.tile_cache, self.tiles = cache, result

    def compose(self, raw, width, height):
        left = 6
        target = memoryview(raw)
        for w, h, pixels, speaking in self.tiles:
            if left+w+1 > width or h+8 > height:
                break
            top = height-6-h
            color = bytes.fromhex('a2db78ff' if speaking else 'a48d5eff')
            edge = color*(w+2)
            offset = ((top-1)*width+left-1)*4
            target[offset:offset+len(edge)] = edge
            for row in range(h):
                offset += width*4
                target[offset:offset+4] = color
                target[offset+4:offset+4+w*4] = pixels[row*w*4:(row+1)*w*4]
                target[offset+4+w*4:offset+8+w*4] = color
            offset += width*4
            target[offset:offset+len(edge)] = edge
            left += w+7

    def publish(self, frame, now, leaving=False):
        if not leaving and now < self.next_write:
            return
        self.next_write = now+.1
        if not self.directory.is_dir():
            return
        source = frame.get('teamPose') or {}
        if not all(number(source.get(k)) for k in ('x','z','yaw')):
            return
        pose = {k:round(source[k],3) for k in ('x','z','yaw')}
        pose.update(moving=not leaving and bool(source.get('moving')),
                    activity='idle' if leaving else source.get('activity','idle'), loadout=source.get('loadout',{}))
        pose['agents'] = [[agent['key'], round(agent['worldX'],2), round(agent['worldZ'],2),
                           round(agent['yaw'],2), agent.get('activity','idle'), bool(agent.get('moving'))]
                          for agent in frame.get('agents',[])[:64] if isinstance(agent.get('key'),str)
                          and all(number(agent.get(k)) for k in ('worldX','worldZ','yaw'))]
        if leaving:
            pose['agents'] = []
        if pose == self.previous_pose and now-self.last_heartbeat < 2:
            return
        temp = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', dir=self.directory, delete=False) as stream:
                temp = stream.name
                json.dump(dict(pose,sceneAt=time.time()),stream,separators=(',',':'), allow_nan=False)
            os.replace(temp, self.directory/'position.json')
            self.previous_pose = pose
            self.last_heartbeat = now
        except OSError:
            pass
        finally:
            if temp:
                Path(temp).unlink(missing_ok=True)
