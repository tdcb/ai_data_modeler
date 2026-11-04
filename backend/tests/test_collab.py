"""Collaboration: live editing over WebSocket, presence, comments, sharing/roles, activity and restore."""
import json

import pytest
from fastapi.testclient import TestClient

from backend.app.main import app


def _login(c, email):
    r = c.post("/api/auth/login", json={"email": email, "password": "password123"})
    if r.status_code != 200:
        pytest.skip(f"seed login unavailable for {email}")
    return r.json()["access_token"]


@pytest.fixture(autouse=True)
def _restore_collab_rows():
    """These tests share the dev control-plane DB: undo their comments, activity, invites and role changes."""
    from backend.app.auth.models import RemoteModelAccessRecord as Acc
    from backend.app.auth.models import SessionLocal
    from backend.app.collab.models import (
        CollabActivityRecord,
        CollabCommentRecord,
        CollabInviteRecord,
    )

    db = SessionLocal()
    max_ids = {m: max([r.id for r in db.query(m.id).all()] or [0]) for m in (CollabActivityRecord, CollabCommentRecord)}
    tokens = {r.token for r in db.query(CollabInviteRecord.token).all()}
    access = {r.id: r.permission for r in db.query(Acc).all()}
    db.close()
    yield
    db = SessionLocal()
    for m, mx in max_ids.items():
        db.query(m).filter(m.id > mx).delete()
    db.query(CollabInviteRecord).filter(CollabInviteRecord.token.notin_(tokens or {""})).delete(synchronize_session=False)
    for rec in db.query(Acc).all():
        if rec.id not in access:
            db.delete(rec)
        elif rec.permission != access[rec.id]:
            rec.permission = access[rec.id]
    db.commit()
    db.close()


@pytest.fixture()
def c():
    with TestClient(app) as client:
        yield client


def _project(c, tok):
    return c.get("/api/project", headers={"Authorization": f"Bearer {tok}"}).json()


def test_live_edit_broadcast_presence_and_activity(c):
    a, v = _login(c, "architect@metaforge.local"), _login(c, "steward@metaforge.local")
    with c.websocket_connect(f"/api/collab/ws/workspace?token={a}") as wa, \
            c.websocket_connect(f"/api/collab/ws/workspace?token={v}") as wb:
        wel_a = wa.receive_json()
        assert wel_a["type"] == "welcome"
        assert wel_a["project"]["entities"]
        assert wa.receive_json()["type"] == "peer_joined"
        wel_b = wb.receive_json()
        assert {p["email"] for p in wel_b["peers"]} == {"architect@metaforge.local", "steward@metaforge.local"}
        wa.send_json({"type": "presence", "selection": {"entity_id": "x"}, "view": "dictionary"})
        pres = wb.receive_json()
        assert pres["type"] == "presence" and pres["peer"]["selection"] == {"entity_id": "x"}
        proj = _project(c, a)
        first = next(iter(proj["entities"].values()))
        first["description"] = "Edited live by architect"
        wa.send_json({"type": "set_project", "project": proj, "base_version": wel_a["version"]})
        ack = wa.receive_json()
        assert ack["type"] == "ack" and ack["version"] == wel_a["version"] + 1
        got = wb.receive_json()
        assert got["type"] == "project" and got["version"] == ack["version"]
        assert got["project"]["entities"][first["id"]]["description"] == "Edited live by architect"
        assert first["physical_name"] in got["summary"]
        # concurrent edits from the same base: different tables merge, the same table reports a conflict
        ids = list(proj["entities"])
        base_v = ack["version"]
        pa, pb = got["project"], json.loads(json.dumps(got["project"]))
        pa["entities"][ids[1]]["description"] = "A edits table 2"
        pb["entities"][ids[2]]["description"] = "B edits table 3"
        pb["entities"][ids[1]]["description"] = "B also edits table 2"
        wa.send_json({"type": "set_project", "project": pa, "base_version": base_v})
        assert wa.receive_json()["type"] == "ack"
        assert wb.receive_json()["type"] == "project"
        wb.send_json({"type": "set_project", "project": pb, "base_version": base_v})
        ack_b = wb.receive_json()
        assert ack_b["type"] == "ack" and ack_b["conflicts"] == [pb["entities"][ids[1]]["physical_name"]]
        seen_a = wa.receive_json()
        assert seen_a["project"] == ack_b["project"]
        merged = ack_b["project"]["entities"]
        assert merged[ids[1]]["description"] == "B also edits table 2"
        assert merged[ids[2]]["description"] == "B edits table 3"
        # live workspace edits get the same business-text sanitizing as a reload, so clients never diverge
        reloaded = c.get("/api/project", headers={"Authorization": f"Bearer {a}"}).json()
        assert reloaded["entities"][ids[2]]["description"] == merged[ids[2]]["description"]
        # an edit to a different table from a stale base keeps the other user's newer change
        pa2 = json.loads(json.dumps(pa))
        pa2["entities"][ids[3]]["description"] = "A edits table 4 from stale base"
        wa.send_json({"type": "set_project", "project": pa2, "base_version": base_v + 1})
        ack_a2 = wa.receive_json()
        assert ack_a2["conflicts"] == []
        e2 = ack_a2["project"]["entities"]
        assert e2[ids[2]]["description"] == "B edits table 3" and e2[ids[3]]["description"].startswith("A edits table 4")
        wb.receive_json()
    feed = c.get("/api/collab/workspace/activity", headers={"Authorization": f"Bearer {a}"}).json()
    assert feed[0]["kind"] == "edit" and feed[0]["restorable"]


def test_viewer_is_read_only_and_restore(c):
    a, viewer = _login(c, "architect@metaforge.local"), _login(c, "viewer@metaforge.local")
    ha = {"Authorization": f"Bearer {a}"}
    original = _project(c, a)
    with c.websocket_connect(f"/api/collab/ws/workspace?token={a}") as wa:
        ver = wa.receive_json()["version"]
        wa.send_json({"type": "set_project", "project": original, "base_version": ver})
        wa.receive_json()
        changed = _project(c, a)
        eid = next(iter(changed["entities"]))
        changed["entities"][eid]["description"] = "to be undone"
        wa.send_json({"type": "set_project", "project": changed, "base_version": ver + 1})
        wa.receive_json()
    with c.websocket_connect(f"/api/collab/ws/workspace?token={viewer}") as wv:
        wv.receive_json()
        wv.send_json({"type": "set_project", "project": original, "base_version": 0})
        assert wv.receive_json()["type"] == "error"
    feed = c.get("/api/collab/workspace/activity", headers=ha).json()
    target = [e for e in feed if e["kind"] == "edit"][1]
    hv = {"Authorization": f"Bearer {viewer}"}
    assert c.post(f"/api/collab/workspace/restore/{target['id']}", headers=hv).status_code == 403
    r = c.post(f"/api/collab/workspace/restore/{target['id']}", headers=ha)
    assert r.status_code == 200
    assert _project(c, a)["entities"][eid]["description"] == original["entities"][eid]["description"]
    assert c.get("/api/collab/workspace/activity", headers=ha).json()[0]["kind"] == "restore"


def test_comments_threads_mentions_resolve(c):
    a, viewer = _login(c, "architect@metaforge.local"), _login(c, "viewer@metaforge.local")
    ha, hv = {"Authorization": f"Bearer {a}"}, {"Authorization": f"Bearer {viewer}"}
    eid = next(iter(_project(c, a)["entities"]))
    assert c.post("/api/collab/workspace/comments", headers=hv, json={"body": "hi"}).status_code == 403
    root = c.post("/api/collab/workspace/comments", headers=ha,
                  json={"body": "Is this the grain, @steward?", "target_type": "entity", "entity_id": eid}).json()
    assert root["mentions"] == ["steward@metaforge.local"]
    reply = c.post("/api/collab/workspace/comments", headers=ha,
                   json={"body": "Answering", "thread_id": root["thread_id"]}).json()
    assert reply["parent_id"] == root["id"] and reply["entity_id"] == eid
    thread = c.patch(f"/api/collab/comments/{root['id']}", headers=ha, json={"resolved": True}).json()
    assert all(x["resolved"] for x in thread) and len(thread) == 2
    listed = c.get("/api/collab/workspace/comments", headers=hv).json()
    assert any(x["thread_id"] == root["thread_id"] for x in listed)


def test_sharing_roles_and_invite_links(c):
    adm, viewer = _login(c, "admin@metaforge.local"), _login(c, "viewer@metaforge.local")
    h, hv = {"Authorization": f"Bearer {adm}"}, {"Authorization": f"Bearer {viewer}"}
    assert c.post("/api/collab/workspace/invites", headers=hv, json={"role": "EDIT"}).status_code == 403
    link = c.post("/api/collab/workspace/invites", headers=h, json={"role": "COMMENT"}).json()
    assert link["link"].startswith("/?invite=") and not link["accepted"]
    ok = c.post(f"/api/collab/invites/{link['token']}/accept", headers=hv).json()
    assert ok["permission"] == "COMMENT"
    assert c.post("/api/collab/workspace/comments", headers=hv, json={"body": "now I can comment"}).status_code == 200
    direct = c.post("/api/collab/workspace/invites", headers=h,
                    json={"email": "viewer@metaforge.local", "role": "EDIT"}).json()
    assert direct["accepted"]
    m = c.get("/api/collab/workspace/members", headers=hv).json()
    assert m["my_permission"] == "EDIT" and m["invites"] == []
    assert c.get("/api/collab/workspace/members", headers=h).json()["invites"]
    c.put("/api/collab/workspace/members/viewer@metaforge.local", headers=h, json={"role": "VIEW"})
    assert c.get("/api/collab/workspace/members", headers=hv).json()["my_permission"] == "VIEW"
    c.delete(f"/api/collab/invites/{link['token']}", headers=h)
    assert c.post(f"/api/collab/invites/{link['token']}/accept", headers=hv).status_code == 404


def test_ws_rejects_bad_token(c):
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with c.websocket_connect("/api/collab/ws/workspace?token=bogus") as w:
            w.receive_json()
