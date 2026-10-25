import pytest

from backend.app import Broker


class FakeWebSocket:
    def __init__(self):
        self.events = []

    async def send_json(self, event):
        self.events.append(event)


@pytest.mark.asyncio
async def test_publish_sends_new_alert_once_and_advances_cursor():
    broker = Broker()
    socket = FakeWebSocket()
    broker.clients[socket] = 40
    event = {"event": "alert", "event_seq": 41, "alert_id": "a-41", "alert_type": "GEOFENCE_BREACH"}

    await broker.publish(event)
    await broker.publish(event)

    assert socket.events == [event]
    assert broker.clients[socket] == 41


@pytest.mark.asyncio
async def test_publish_keeps_out_of_order_commit_after_cursor_advance():
    broker = Broker()
    socket = FakeWebSocket()
    broker.clients[socket] = 50

    event = {"event_seq": 50, "alert_id": "a-50", "alert_type": "DRIFT_WARNING"}
    await broker.publish(event)

    assert socket.events == [event]
