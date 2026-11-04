"""In-memory collaboration rooms: connected peers, presence and the server-ordered model version."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from fastapi import WebSocket

PALETTE = ["#f97316", "#22c55e", "#3b82f6", "#e11d48", "#a855f7", "#14b8a6", "#eab308", "#ec4899"]


@dataclass
class Peer:
    ws: WebSocket
    client_id: str
    email: str
    name: str
    role: str
    color: str
    selection: Dict[str, Any] = field(default_factory=dict)
    view: str = "canvas"

    def public(self) -> Dict[str, Any]:
        return {"client_id": self.client_id, "email": self.email, "name": self.name, "role": self.role,
                "color": self.color, "selection": self.selection, "view": self.view}


@dataclass
class Room:
    model_id: str
    version: int = 0
    peers: Dict[str, Peer] = field(default_factory=dict)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    current: Optional[Dict[str, Any]] = None  # authoritative project, avoids lossy reloads from disk
    history: Dict[int, Dict[str, Any]] = field(default_factory=dict)  # recent versions, base for merges

    def remember(self, project: Dict[str, Any], keep: int = 100) -> None:
        self.current = project
        self.history[self.version] = project
        for v in sorted(self.history)[:-keep]:
            del self.history[v]

    def next_color(self) -> str:
        used = {p.color for p in self.peers.values()}
        return next((c for c in PALETTE if c not in used), PALETTE[len(self.peers) % len(PALETTE)])


class Hub:
    def __init__(self) -> None:
        self.rooms: Dict[str, Room] = {}

    def room(self, model_id: str, version: int = 0) -> Room:
        if model_id not in self.rooms:
            self.rooms[model_id] = Room(model_id=model_id, version=version)
        return self.rooms[model_id]

    def peers(self, model_id: str) -> List[Dict[str, Any]]:
        r = self.rooms.get(model_id)
        return [p.public() for p in r.peers.values()] if r else []

    async def broadcast(self, model_id: str, message: Dict[str, Any], exclude: Optional[str] = None) -> None:
        r = self.rooms.get(model_id)
        if not r:
            return
        dead = []
        for cid, p in list(r.peers.items()):
            if cid == exclude:
                continue
            try:
                await p.ws.send_json(message)
            except Exception:
                dead.append(cid)
        for cid in dead:
            r.peers.pop(cid, None)


hub = Hub()
